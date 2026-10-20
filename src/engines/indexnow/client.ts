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
 * errors or tool output: every message built here passes through
 * redactSecret().
 */
import { parseHttpUrl, redactSecret } from '../types.js';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_MAX_URLS = 10_000;
/** 8-128 characters of a-z, A-Z, 0-9 and dashes. */
export const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/** The key-file check reads at most this many bytes (a key is at most 128 characters). */
export const KEY_FILE_MAX_BYTES = 64 * 1024;
/** Same-host https redirects the key-file check follows before giving up. */
export const KEY_FILE_MAX_REDIRECTS = 3;

export function isValidIndexNowKey(key: string): boolean {
  return INDEXNOW_KEY_PATTERN.test(key);
}

export interface IndexNowConfig {
  key: string;
  /** INDEXNOW_KEY_LOCATION: absolute URL, or a path resolved against each submission's host. */
  keyLocation?: string;
  /** INDEXNOW_HOSTS: hosts (lowercase, optional :port) whose key file indexnow_check_key_file may fetch. */
  hosts?: string[];
}

/** Parse INDEXNOW_HOSTS: comma- or space-separated host names; a full URL contributes its host. */
export function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    const asUrl = parseHttpUrl(v.includes('://') ? v : `https://${v}`);
    if (asUrl) out.add(asUrl.host);
  }
  return [...out];
}

/**
 * Hosts the key-file check may contact: the INDEXNOW_HOSTS allowlist plus the
 * host of an absolute INDEXNOW_KEY_LOCATION. Empty means the check is refused,
 * so a caller can never point it (and the key in the default file name) at an
 * arbitrary host.
 */
export function allowedKeyFileHosts(cfg: IndexNowConfig): Set<string> {
  const hosts = new Set(cfg.hosts ?? []);
  const raw = cfg.keyLocation?.trim();
  if (raw && !raw.startsWith('/')) {
    const u = parseHttpUrl(raw);
    if (u) hosts.add(u.host.toLowerCase());
  }
  return hosts;
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
  const plan = buildPlan(urls, cfg);
  // Errors echo URLs, hosts and key-file paths, any of which may contain the key.
  return plan.ok ? plan : { ok: false, error: redactSecret(plan.error, cfg.key) };
}

function buildPlan(urls: readonly string[], cfg: IndexNowConfig): IndexNowPlan {
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
    return { ok: false, error: `Not absolute http(s) URLs (or they carry credentials): ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? ', ...' : ''}` };
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

/**
 * Where the key file is expected for URLs like `sample`. The default file and
 * a path location always resolve to https on the sample's host, whatever the
 * sample's scheme. keyLocation is set only when it differs from the default
 * root file.
 */
export function resolveKeyLocation(cfg: IndexNowConfig, sample: URL): KeyLocationResult {
  const origin = `https://${sample.host}`;
  const raw = cfg.keyLocation?.trim();
  if (!raw) return { ok: true, keyFileUrl: `${origin}/${cfg.key}.txt` };
  let url: URL | null;
  if (raw.startsWith('/')) {
    url = parseHttpUrl(origin + raw);
  } else {
    url = parseHttpUrl(raw);
  }
  if (!url) {
    return { ok: false, error: 'INDEXNOW_KEY_LOCATION must be an absolute http(s) URL (without credentials) or a path starting with "/".' };
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

  /**
   * Fetch the key file and check that it holds the key. Never returns the file
   * contents. Only https is fetched; redirects are followed only to https on
   * the same host (at most KEY_FILE_MAX_REDIRECTS); the body is capped at
   * KEY_FILE_MAX_BYTES; one timeout covers the whole check. The caller decides
   * which hosts may be contacted (see allowedKeyFileHosts).
   */
  async checkKeyFile(keyFileUrl: string): Promise<{ url: string; status: number | null; matches: boolean; message: string }> {
    const fail = (url: string, status: number | null, message: string) => ({
      url: this.redact(url),
      status,
      matches: false,
      message: this.redact(message),
    });
    let url = parseHttpUrl(keyFileUrl);
    if (!url || url.protocol !== 'https:') return fail(keyFileUrl, null, 'The key file must be checked over https.');
    const host = url.host.toLowerCase();
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      for (let hops = 0; ; hops++) {
        res = await this.fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal });
        if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break;
        await res.body?.cancel().catch(() => undefined);
        const next = parseHttpUrl(new URL(res.headers.get('location')!, url).href);
        if (!next || next.protocol !== 'https:' || next.host.toLowerCase() !== host) {
          return fail(url.href, res.status, `The key file redirects (HTTP ${res.status}) away from https://${host}; redirects to another host or to http are not followed. Serve the key file directly on ${host}.`);
        }
        if (hops >= KEY_FILE_MAX_REDIRECTS) {
          return fail(url.href, res.status, `The key file redirected more than ${KEY_FILE_MAX_REDIRECTS} times.`);
        }
        url = next;
      }
    } catch (e) {
      return fail(url.href, null, `Could not fetch the key file: ${describe(e, this.timeoutMs)}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return fail(url.href, res.status, `The key file answered HTTP ${res.status}; it must be publicly reachable with HTTP 200.`);
    }
    let content: string;
    try {
      const body = await readCapped(res, KEY_FILE_MAX_BYTES);
      if (body === null) {
        return fail(url.href, 200, `The key file is larger than ${KEY_FILE_MAX_BYTES} bytes; it should hold only the key.`);
      }
      content = body.replace(/^\uFEFF/, '').trim();
    } catch (e) {
      return fail(url.href, 200, `Could not read the key file: ${describe(e, this.timeoutMs)}`);
    }
    const matches = content === this.key;
    return {
      url: this.redact(url.href),
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

/** Read a response body as UTF-8, or null when it exceeds maxBytes (the rest is not downloaded). */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function describe(e: unknown, timeoutMs: number): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : e.message;
  return String(e);
}
