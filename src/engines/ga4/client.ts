/**
 * Google Analytics Admin + Data API client (REST, fetch only).
 *
 * - Admin v1beta: account summaries, property get, Google Ads links
 * - Admin v1alpha: reporting-data annotations (read)
 * - Data v1beta: runReport, runRealtimeReport, getMetadata, checkCompatibility
 * - Data v1alpha: runFunnelReport, conversions runReport (conversionSpec)
 *
 * Tool arguments may use snake_case (as in protocol-buffer examples) or the
 * REST camelCase names; bodies sent to Google are camelCase.
 */
import { TokenProvider, TokenRefreshError } from '../../lib/auth.js';

export const GA4_ADMIN_BASE = 'https://analyticsadmin.googleapis.com';
export const GA4_DATA_BASE = 'https://analyticsdata.googleapis.com';

export class Ga4ApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, message: string, reason: string | null = null) {
    super(message);
    this.name = 'Ga4ApiError';
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

export interface Ga4RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | null | undefined>;
  body?: unknown;
  /** Google account id from TokenProvider.accountIds(). Default / fallback when omitted. */
  account?: string;
}

export interface Ga4ClientOptions {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  timeoutMs?: number;
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 10_000;
const MAX_LIST_PAGES = 50;

/**
 * Thin REST client for the Analytics Admin and Data APIs. Retry and 401
 * handling match the Search Console client: network / timeout / 429 / 5xx /
 * quota, Retry-After up to MAX_RETRY_AFTER_MS, one fresh-token retry on 401.
 */
export class Ga4Client {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: Ga4ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  accountIds(): Promise<string[]> {
    return this.opts.tokenProvider.accountIds();
  }

  /**
   * Send as a specific account, or try each connected account on 403/404 so a
   * property owned by a non-default Google account still works.
   */
  async request<T>(base: string, path: string, options: Ga4RequestOptions = {}): Promise<T> {
    if (options.account !== undefined) {
      const result = await this.send<T>(base, path, options, options.account);
      return result;
    }
    const ids = await this.opts.tokenProvider.accountIds();
    if (ids.length <= 1) {
      const result = await this.send<T>(base, path, options, ids[0]);
      return result;
    }
    let last: unknown;
    for (let i = 0; i < ids.length; i++) {
      try {
        const result = await this.send<T>(base, path, options, ids[i]);
        return result;
      } catch (e) {
        last = e;
        const retryable = e instanceof Ga4ApiError && (e.status === 403 || e.status === 404);
        if (!retryable || i >= ids.length - 1) throw e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** GET every page of a list method; `itemsKey` is the array field on each page. */
  async listAll<T>(
    base: string,
    path: string,
    itemsKey: string,
    options: Ga4RequestOptions = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = { ...(options.query ?? {}) };
      if (pageToken) query.pageToken = pageToken;
      const res = await this.request<Record<string, unknown>>(base, path, { ...options, query });
      const items = res[itemsKey];
      if (Array.isArray(items)) out.push(...(items as T[]));
      const next = res.nextPageToken;
      if (typeof next !== 'string' || next === '') break;
      pageToken = next;
    }
    return out;
  }

  private async send<T>(
    base: string,
    path: string,
    options: Ga4RequestOptions,
    account: string | undefined,
  ): Promise<T> {
    const { method = 'GET', query, body } = options;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v != null) url.searchParams.set(k, v);
    }
    const endpoint = `${method} ${path}`;

    let accessToken = await this.opts.tokenProvider.getAccessToken(account);
    let retriedUnauthorized = false;

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= this.maxAttempts - 1;
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(toRestJson(body));
      }

      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, init);
        text = res.ok ? await res.text() : '';
      } catch (e) {
        if (isLastAttempt) throw new Error(`GA4 request ${endpoint} failed: ${this.describe(e)}`);
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
        throw new Ga4ApiError(res.status, message, reason);
      }

      let delay = backoffMs(attempt);
      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseRetryAfterMs(res.headers.get('Retry-After'));
        if (retryAfter !== null) {
          if (retryAfter > this.maxRetryAfterMs) {
            throw new Ga4ApiError(
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

function parseSuccessBody<T>(text: string, res: Response, endpoint: string): T {
  if (text.trim() === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = res.headers.get('Content-Type') ?? 'no content type';
    throw new Ga4ApiError(
      res.status,
      `GA4 returned a non-JSON response for ${endpoint} (HTTP ${res.status}, ${type})`,
    );
  }
}

export function parseRetryAfterMs(raw: string | null, now: number = Date.now()): number | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value === '') return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
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

/**
 * Property resource name `properties/{id}`. Accepts a number, a digit string,
 * or a value that already starts with `properties/`.
 */
export function propertyResourceName(propertyId: string | number): string {
  const raw = String(propertyId).trim();
  if (/^\d+$/.test(raw)) return `properties/${raw}`;
  const m = /^properties\/(\d+)$/i.exec(raw);
  if (m) return `properties/${m[1]}`;
  throw new Error(
    `Invalid property ID: ${propertyId}. Use a number or properties/<number> (see ga4_get_account_summaries).`,
  );
}

/** Recursively convert snake_case keys to REST camelCase; leave camelCase as-is. */
export function toRestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toRestJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[snakeToCamel(k)] = toRestJson(v);
    }
    return out;
  }
  return value;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function namedFields(names: readonly string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

export { TokenRefreshError };
