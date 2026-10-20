/**
 * Seznam Webmaster API client. The API is described by Seznam's own Swagger
 * document at https://reporter.seznam.cz/wm-api/swagger.json (UI:
 * https://reporter.seznam.cz/wm-api/ui/), served from
 * https://reporter.seznam.cz/wm-api.
 *
 * Every call is authenticated with a per-site API key in the `key` query
 * parameter; there is no site parameter, the key selects the site. fetch only
 * (Workers, Node, stdio). The key is never logged and is scrubbed from any
 * error text before it leaves this module.
 */

export const SEZNAM_API_BASE = 'https://reporter.seznam.cz/wm-api';

/** Limits published in the Swagger description (per user and per site). */
export const SEZNAM_LIMITS = 'at most 5 requests per second and 100 per minute per user and site; reindex at most 500 times a day';

export class SeznamApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SeznamApiError';
    this.status = status;
  }
}

/** Problem JSON as documented (title, description) and as served (title, detail). */
interface ProblemBody {
  title?: string;
  detail?: string;
  description?: string;
  status?: number;
}

export type SeznamResult<T> = { noData: false; data: T } | { noData: true };

export interface SeznamClientOptions {
  fetchImpl?: typeof fetch;
  /** Attempts for network errors, 429, 502 and 503. Default 3. */
  maxAttempts?: number;
  /** Base delay between retries in ms (doubles each time). Default 1000. */
  retryDelayMs?: number;
}

export function redactKey(text: string, key: string): string {
  let out = text.replace(/([?&])key=[^&\s"'<>]+/gi, '$1key=REDACTED');
  if (key) out = out.split(key).join('REDACTED');
  return out;
}

export class SeznamWebmasterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(opts: SeznamClientOptions = {}) {
    // A bare `fetch` reference as default breaks on workerd (see TokenProvider).
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
  }

  /**
   * GET returns the parsed JSON, or noData for 204 ("the request succeeded
   * but the data is not available yet"). POST (reindex) returns no body.
   */
  async request<T>(path: string, key: string, options: { method?: 'GET' | 'POST'; query?: Record<string, string | null | undefined> } = {}): Promise<SeznamResult<T>> {
    const { method = 'GET', query } = options;
    const url = new URL(`${SEZNAM_API_BASE}${path}`);
    url.searchParams.set('key', key);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await this.sleep(attempt - 1);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers: { Accept: 'application/json' } });
      } catch (e) {
        lastError = new SeznamApiError(0, redactKey(`network error calling Seznam Webmaster: ${e instanceof Error ? e.message : String(e)}`, key));
        continue;
      }
      if (res.status === 204) {
        await res.body?.cancel();
        return { noData: true };
      }
      if (res.ok) {
        const text = await res.text();
        if (method === 'POST' || text.trim() === '') {
          return method === 'POST' ? { noData: false, data: undefined as T } : { noData: true };
        }
        try {
          return { noData: false, data: JSON.parse(text) as T };
        } catch {
          throw new SeznamApiError(502, 'Seznam Webmaster returned a non-JSON response');
        }
      }
      const err = new SeznamApiError(res.status, redactKey(await problemText(res), key));
      if ([429, 502, 503].includes(res.status)) {
        lastError = err;
        continue;
      }
      throw err;
    }
    throw lastError ?? new SeznamApiError(500, 'request failed');
  }

  private sleep(n: number): Promise<void> {
    const ms = this.retryDelayMs * 2 ** n;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}

async function problemText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const p = JSON.parse(text) as ProblemBody;
    const parts = [p.title, p.detail ?? p.description].filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (parts.length > 0) return parts.join(': ');
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 300) || `HTTP ${res.status}`;
}
