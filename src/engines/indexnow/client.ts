/**
 * IndexNow protocol client (https://www.indexnow.org/documentation).
 *
 * POST https://api.indexnow.org/indexnow with
 *   {"host": "...", "key": "...", "keyLocation": "...", "urlList": [...]}
 * up to 10,000 URLs per request. Responses: 200 OK, 202 Accepted (key
 * validation pending), 400 Bad request, 403 Forbidden (key not valid),
 * 422 Unprocessable Entity (URLs not on the host / key schema mismatch),
 * 429 Too Many Requests.
 *
 * Web-standard fetch only (Workers-compatible). The key never appears in
 * errors or tool output.
 */
import { parseHttpUrl, redactSecret } from '../types.js';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_MAX_URLS = 10_000;
/** 8-128 characters of a-z, A-Z, 0-9 and dashes. */
export const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export function isValidIndexNowKey(key: string): boolean {
  return INDEXNOW_KEY_PATTERN.test(key);
}

export interface IndexNowConfig {
  key: string;
  /** INDEXNOW_KEY_LOCATION: absolute URL, or a path resolved against each submission's host. */
  keyLocation?: string;
}

export type IndexNowPlan =
  | { ok: true; host: string; keyFileUrl: string; keyLocation?: string; urlList: string[] }
  | { ok: false; error: string };

/**
 * Validate a submission and build the request fields. All URLs must be
 * absolute http(s) URLs on one host; the key file must be on that host, and
 * a non-root key file only covers URLs under its directory.
 */
export function planSubmission(urls: readonly string[], cfg: IndexNowConfig): IndexNowPlan {
  if (!isValidIndexNowKey(cfg.key)) {
    return { ok: false, error: 'INDEXNOW_KEY is not a valid IndexNow key: it must be 8-128 characters of a-z, A-Z, 0-9 and "-".' };
  }
  const urlList = [...new Set(urls.map((u) => u.trim()).filter((u) => u.length > 0))];
  if (urlList.length === 0) return { ok: false, error: 'No URLs to submit.' };
  if (urlList.length > INDEXNOW_MAX_URLS) {
    return { ok: false, error: `IndexNow accepts at most ${INDEXNOW_MAX_URLS} URLs per request; got ${urlList.length}.` };
  }
  const parsed: URL[] = [];
  const invalid: string[] = [];
  for (const u of urlList) {
    const p = parseHttpUrl(u);
    if (p) parsed.push(p);
    else invalid.push(u);
  }
  if (invalid.length > 0) {
    return { ok: false, error: `Not absolute http(s) URLs: ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? ', ...' : ''}` };
  }
  const hosts = [...new Set(parsed.map((p) => p.host.toLowerCase()))];
  if (hosts.length > 1) {
    return {
      ok: false,
      error: `All URLs in one IndexNow submission must share one host; got ${hosts.length}: ${hosts.slice(0, 5).join(', ')}. Submit each host separately.`,
    };
  }
  const host = hosts[0]!;
  const first = parsed[0]!;

  const loc = resolveKeyLocation(cfg, first);
  if (!loc.ok) return loc;
  if (loc.keyLocation) {
    const keyUrl = new URL(loc.keyLocation);
    if (keyUrl.host.toLowerCase() !== host) {
      return {
        ok: false,
        error: `INDEXNOW_KEY_LOCATION is on ${keyUrl.host}, but the URLs are on ${host}. The key file must be hosted on the same host as the submitted URLs; set INDEXNOW_KEY_LOCATION to a path (e.g. /indexnow-key.txt) to use it on every host.`,
      };
    }
    // A key file at /catalog/key.txt only covers URLs under /catalog/.
    const scope = keyUrl.pathname.slice(0, keyUrl.pathname.lastIndexOf('/') + 1);
    const outside = parsed.filter((p) => !p.pathname.startsWith(scope)).map((p) => p.href);
    if (scope !== '/' && outside.length > 0) {
      return {
        ok: false,
        error: `The key file ${keyUrl.pathname} only covers URLs under ${scope}; these are outside it: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''}. Host the key file at the site root instead.`,
      };
    }
  }
  const plan: IndexNowPlan = { ok: true, host, keyFileUrl: loc.keyFileUrl, urlList: parsed.map((p) => p.href) };
  if (loc.keyLocation) plan.keyLocation = loc.keyLocation;
  return plan;
}

type KeyLocationResult = { ok: true; keyFileUrl: string; keyLocation?: string } | { ok: false; error: string };

/** Where the key file is expected for URLs like `sample`. keyLocation is set only when it differs from the default root file. */
export function resolveKeyLocation(cfg: IndexNowConfig, sample: URL): KeyLocationResult {
  const origin = `${sample.protocol}//${sample.host}`;
  const raw = cfg.keyLocation?.trim();
  if (!raw) return { ok: true, keyFileUrl: `${origin}/${cfg.key}.txt` };
  let url: URL | null;
  if (raw.startsWith('/')) {
    url = parseHttpUrl(origin + raw);
  } else {
    url = parseHttpUrl(raw);
  }
  if (!url) {
    return { ok: false, error: 'INDEXNOW_KEY_LOCATION must be an absolute http(s) URL or a path starting with "/".' };
  }
  return { ok: true, keyFileUrl: url.href, keyLocation: url.href };
}

export type IndexNowOutcome =
  | { ok: true; status: 200 | 202; message: string }
  | { ok: false; status: number; message: string };

const STATUS_MESSAGES: Record<number, string> = {
  200: 'Submitted. IndexNow received the URLs (this does not guarantee crawling or indexing).',
  202: 'Accepted. IndexNow received the URLs; validation of the key file is still pending.',
  400: 'IndexNow rejected the request as invalid (HTTP 400 Bad request).',
  403: 'IndexNow rejected the key (HTTP 403 Forbidden): the key file was not found on the host, or it does not contain the key. Check it with indexnow_check_key_file.',
  422: 'IndexNow could not process the request (HTTP 422): some URLs do not belong to the host, or the key does not match the protocol schema.',
  429: 'IndexNow is rate-limiting this sender (HTTP 429 Too Many Requests, potential spam). Submit less often; avoid resubmitting unchanged URLs.',
};

export interface IndexNowClientOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export class IndexNowClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly key: string, opts: IndexNowClientOptions = {}) {
    // A bare `fetch` reference as default breaks on workerd (illegal invocation).
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.endpoint = opts.endpoint ?? INDEXNOW_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async submit(plan: Extract<IndexNowPlan, { ok: true }>): Promise<IndexNowOutcome> {
    const body: Record<string, unknown> = { host: plan.host, key: this.key };
    if (plan.keyLocation) body.keyLocation = plan.keyLocation;
    body.urlList = plan.urlList;
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, message: this.redact(`IndexNow request failed: ${describe(e, this.timeoutMs)}`) };
    }
    const text = (await res.text().catch(() => '')).trim();
    if (res.status === 200 || res.status === 202) {
      return { ok: true, status: res.status, message: STATUS_MESSAGES[res.status]! };
    }
    const base = STATUS_MESSAGES[res.status] ?? `IndexNow returned HTTP ${res.status}.`;
    const detail = text ? ` Response: ${this.redact(text.slice(0, 300))}` : '';
    return { ok: false, status: res.status, message: base + detail };
  }

  /** Fetch the key file and check that it holds the key. Never returns the file contents. */
  async checkKeyFile(keyFileUrl: string): Promise<{ url: string; status: number | null; matches: boolean; message: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(keyFileUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      return { url: keyFileUrl, status: null, matches: false, message: this.redact(`Could not fetch the key file: ${describe(e, this.timeoutMs)}`) };
    }
    if (res.status !== 200) {
      return { url: keyFileUrl, status: res.status, matches: false, message: `The key file answered HTTP ${res.status}; it must be publicly reachable with HTTP 200.` };
    }
    const content = (await res.text().catch(() => '')).replace(/^\uFEFF/, '').trim();
    const matches = content === this.key;
    return {
      url: keyFileUrl,
      status: 200,
      matches,
      message: matches
        ? 'The key file is reachable and contains INDEXNOW_KEY.'
        : 'The key file is reachable but does not contain exactly INDEXNOW_KEY (it should hold only the key, UTF-8).',
    };
  }

  private redact(text: string): string {
    return redactSecret(text, this.key);
  }
}

function describe(e: unknown, timeoutMs: number): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : e.message;
  return String(e);
}
