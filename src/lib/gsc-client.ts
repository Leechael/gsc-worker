import { TokenProvider, TokenRefreshError } from './auth.js';
import { PropertyRouter, siteUrlOfRequest, type AccountSites, type SiteEntry } from './account-router.js';

/** Base URL for the Search Console API (plan §1.5: 统一用新基址). */
export const GSC_BASE_URL = 'https://searchconsole.googleapis.com';

/** Structured Google API error, mapped to friendly messages by tools. */
export class GscApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, message: string, reason: string | null = null) {
    super(message);
    this.name = 'GscApiError';
    this.status = status;
    this.reason = reason;
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; [k: string]: unknown }[];
  };
}

export interface GscRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  query?: Record<string, string | null | undefined>;
  body?: unknown;
  /**
   * Google account to use (an id from TokenProvider.accountIds()). When
   * omitted and several accounts are connected, the account is chosen by the
   * property the request is about.
   */
  account?: string;
}

export interface GscClientOptions {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  /** Max attempts for retryable failures (429 / 5xx / quota). Default 4. */
  maxAttempts?: number;
  /** Per-attempt timeout in ms. Default DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Longest Retry-After (ms) we are willing to wait. Default MAX_RETRY_AFTER_MS. */
  maxRetryAfterMs?: number;
  /** Delay function; injectable so tests do not wait for real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/** Each HTTP attempt is aborted after this long (covers headers and body). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound for honoring a Retry-After header on 429/503. A tool call that
 * would otherwise block for longer fails fast and tells the caller to retry.
 */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Thin REST client for the Search Console API (plan §2: 裸 fetch 直调).
 *
 * Retries network errors, timeouts, 429, 5xx and quota-exceeded responses
 * with exponential backoff + jitter, honoring Retry-After on 429/503 up to
 * MAX_RETRY_AFTER_MS. No delay is spent after the final attempt.
 */
export class GscClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Property → account routing; only consulted when several accounts are connected. */
  readonly router: PropertyRouter;

  constructor(private readonly opts: GscClientOptions) {
    // See TokenProvider: bare `fetch` as a default breaks on workerd.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.router = new PropertyRouter({
      accountIds: () => opts.tokenProvider.accountIds(),
      listSites: async (account) =>
        (await this.send<{ siteEntry?: SiteEntry[] }>('/webmasters/v3/sites', {}, account)).siteEntry ?? [],
    });
  }

  /** Connected account ids, default first. */
  accountIds(): Promise<string[]> {
    return this.opts.tokenProvider.accountIds();
  }

  /** Every account's properties (for list_properties). `fresh` refreshes the routing map. */
  sitesByAccount(opts: { fresh?: boolean } = {}): Promise<AccountSites[]> {
    return this.router.sitesByAccount(opts);
  }

  /**
   * Send a request as the right account. With one account (the usual case)
   * this is a plain request. With several, a request about a property goes
   * to the account with the highest permission on it; a 403 moves on to the
   * next account that lists the property. Requests about no property, or a
   * property no account lists, use the default account.
   */
  async request<T>(path: string, options: GscRequestOptions = {}): Promise<T> {
    const result = await this.routedRequest<T>(path, options);
    // sites.add / sites.delete change which account lists the property.
    if ((options.method === 'PUT' || options.method === 'DELETE') && /^\/webmasters\/v3\/sites\/[^/]+$/.test(path)) {
      this.router.invalidate();
    }
    return result;
  }

  private async routedRequest<T>(path: string, options: GscRequestOptions): Promise<T> {
    if (options.account !== undefined) return this.send<T>(path, options, options.account);
    const ids = await this.opts.tokenProvider.accountIds();
    const site = ids.length > 1 ? siteUrlOfRequest(path, options.body) : null;
    const candidates = site === null ? [] : await this.router.candidates(site);
    if (candidates.length === 0) return this.send<T>(path, options, undefined);
    for (let i = 0; ; i++) {
      try {
        return await this.send<T>(path, options, candidates[i]);
      } catch (e) {
        if (!(e instanceof GscApiError && e.status === 403) || i >= candidates.length - 1) throw e;
        // Permissions changed since the map was built.
        this.router.invalidate();
      }
    }
  }

  private async send<T>(path: string, options: GscRequestOptions, account: string | undefined): Promise<T> {
    const { method = 'GET', query, body } = options;
    const url = new URL(`${GSC_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      // null means the argument was omitted.
      if (v != null) url.searchParams.set(k, v);
    }
    // Used in error messages; the query string is left out on purpose.
    const endpoint = `${method} ${path}`;

    let accessToken = await this.opts.tokenProvider.getAccessToken(account);
    // A cached access token can be revoked before it expires (disconnect or
    // re-authorization in another isolate); retry once with a fresh one.
    let retriedUnauthorized = false;

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= this.maxAttempts - 1;
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, init);
        // Read inside the try so a stalled body also hits the timeout.
        text = res.ok ? await res.text() : '';
      } catch (e) {
        // Network-level failure or timeout — retryable.
        if (isLastAttempt) throw new Error(`GSC request ${endpoint} failed: ${this.describe(e)}`);
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return parseSuccessBody<T>(text, res, endpoint);

      if (res.status === 401 && !retriedUnauthorized) {
        retriedUnauthorized = true;
        await res.body?.cancel();
        this.opts.tokenProvider.invalidateAccessToken(account);
        accessToken = await this.opts.tokenProvider.getAccessToken(account);
        attempt--;
        continue;
      }

      const errBody = (await res.json().catch(() => null)) as GoogleErrorBody | null;
      const reason = errBody?.error?.details?.find((d) => d.reason)?.reason ?? null;
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;

      if (!isRetryable(res.status, message) || isLastAttempt) {
        throw new GscApiError(res.status, message, reason);
      }

      let delay = backoffMs(attempt);
      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseRetryAfterMs(res.headers.get('Retry-After'));
        if (retryAfter !== null) {
          if (retryAfter > this.maxRetryAfterMs) {
            throw new GscApiError(
              res.status,
              `${message} — ${endpoint} asked to retry after ${Math.ceil(retryAfter / 1000)} s, ` +
                `longer than the ${Math.round(this.maxRetryAfterMs / 1000)} s this server waits; try again later.`,
              reason,
            );
          }
          delay = retryAfter;
        }
      }
      await this.sleep(delay);
    }
  }

  private describe(e: unknown): string {
    if (e instanceof Error) {
      return e.name === 'TimeoutError' ? `timed out after ${this.timeoutMs} ms` : e.message;
    }
    return String(e);
  }
}

/**
 * Empty success bodies (204, or the 200-empty that sites.add / sitemaps.submit
 * return) become `{}`. Anything else must be JSON: an HTML page from a proxy
 * or captive portal is reported instead of silently turning into undefined.
 */
function parseSuccessBody<T>(text: string, res: Response, endpoint: string): T {
  if (text.trim() === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = res.headers.get('Content-Type') ?? 'no content type';
    throw new GscApiError(
      res.status,
      `GSC returned a non-JSON response for ${endpoint} (HTTP ${res.status}, ${type})`,
    );
  }
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns null when absent or unparseable; dates in the past yield 0.
 */
export function parseRetryAfterMs(raw: string | null, now: number = Date.now()): number | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value === '') return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // HTTP-dates always carry a month name; this keeps Date.parse from reading
  // values like "-5" as a year.
  if (!/[a-z]/i.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function isRetryable(status: number, message: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  return /quota exceeded/i.test(message);
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt + Math.random() * 500;
}

/** Re-export for tools that want to narrow error handling. */
export { TokenRefreshError };
