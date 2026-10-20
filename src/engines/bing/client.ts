/**
 * Bing Webmaster Tools API client (JSON endpoint, API-key auth).
 *
 * Reference: https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
 * - GET  https://ssl.bing.com/webmaster/api.svc/json/<Method>?<params>&apikey=KEY
 * - POST https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=KEY with a JSON body
 * - Successful responses are wrapped as {"d": ...}; faults are {"ErrorCode": n, "Message": "..."}.
 * - Dates are WCF strings such as "/Date(1316156400000-0700)/".
 *
 * Web-standard fetch only (Workers-compatible). The API key never appears in
 * errors or tool output.
 */
import { redactSecret } from '../types.js';

export const BING_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

/** ApiErrorCode enum (Microsoft.Bing.Webmaster.Api.Interfaces.ApiErrorCode). */
export const BING_ERROR_CODES: Readonly<Record<number, string>> = {
  0: 'None',
  1: 'InternalError',
  2: 'UnknownError',
  3: 'InvalidApiKey',
  4: 'ThrottleUser',
  5: 'ThrottleHost',
  6: 'UserBlocked',
  7: 'InvalidUrl',
  8: 'InvalidParameter',
  9: 'TooManySites',
  10: 'UserNotFound',
  11: 'NotFound',
  12: 'AlreadyExists',
  13: 'NotAllowed',
  14: 'NotAuthorized',
  15: 'UnexpectedState',
  16: 'Deprecated',
};

export type BingErrorKind = 'throttled' | 'throttled-ip' | 'auth' | 'not-found' | 'invalid' | 'api' | 'network';

export class BingApiError extends Error {
  constructor(
    message: string,
    readonly kind: BingErrorKind,
    readonly status?: number,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'BingApiError';
  }

  get errorName(): string | undefined {
    return this.errorCode === undefined ? undefined : BING_ERROR_CODES[this.errorCode];
  }
}

export interface BingClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 30 s). */
  timeoutMs?: number;
  baseUrl?: string;
}

type QueryValue = string | number | boolean;

export class BingClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: BingClientOptions) {
    this.apiKey = opts.apiKey;
    // A bare `fetch` reference as default breaks on workerd (illegal invocation).
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.baseUrl = opts.baseUrl ?? BING_API_BASE;
  }

  get<T>(method: string, params: Record<string, QueryValue> = {}): Promise<T> {
    return this.call<T>('GET', method, params, undefined);
  }

  post<T>(method: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>('POST', method, {}, body);
  }

  private async call<T>(
    httpMethod: 'GET' | 'POST',
    method: string,
    params: Record<string, QueryValue>,
    body: Record<string, unknown> | undefined,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('apikey', this.apiKey);

    const init: RequestInit = {
      method: httpMethod,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), init);
    } catch (e) {
      const reason = e instanceof Error ? (e.name === 'TimeoutError' ? `timed out after ${this.timeoutMs} ms` : e.message) : String(e);
      throw new BingApiError(this.redact(`Bing ${method} request failed: ${reason}`), 'network');
    }

    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      // A body that cannot be read is never an empty success: a submit would
      // otherwise report success and a read would return no rows.
      if (res.ok) {
        const reason = e instanceof Error ? (e.name === 'TimeoutError' ? `timed out after ${this.timeoutMs} ms` : e.message) : String(e);
        throw new BingApiError(this.redact(`Bing ${method} response could not be read (HTTP ${res.status}): ${reason}`), 'network', res.status);
      }
      text = '';
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }

    const fault = asFault(json);
    // A plain-text "ThrottleIP" body is an error even when the status is 200.
    if (!res.ok || fault || (json === undefined && /ThrottleIP/i.test(text))) {
      throw this.toError(method, res.status, fault, text);
    }
    if (json === undefined) {
      throw new BingApiError(`Bing ${method} returned a non-JSON response (HTTP ${res.status}).`, 'api', res.status);
    }
    if (json && typeof json === 'object' && 'd' in json) return (json as { d: T }).d;
    return json as T;
  }

  /** Redact the key raw, URL-encoded, and form-encoded (as URLSearchParams writes it into the request URL). */
  private redact(text: string): string {
    const formEncoded = new URLSearchParams({ k: this.apiKey }).toString().slice(2);
    return redactSecret(redactSecret(text, this.apiKey), formEncoded);
  }

  private toError(method: string, status: number, fault: Fault | null, raw: string): BingApiError {
    const message = fault?.Message ?? raw.trim().slice(0, 300);
    const code = fault?.ErrorCode;
    const name = code === undefined ? undefined : BING_ERROR_CODES[code] ?? `ErrorCode ${code}`;
    const detail = this.redact([name, message].filter(Boolean).join(': ') || `HTTP ${status}`);

    if (/ThrottleIP/i.test(raw)) {
      return new BingApiError(
        `Bing ${method} was refused with ThrottleIP: Bing is throttling the IP address this server calls from. ` +
          'On Cloudflare Workers this can happen because outbound requests share Cloudflare egress IPs. ' +
          'Retrying from the same Worker usually does not help; run the Node or stdio entry from your own machine or server for Bing calls. ' +
          `(HTTP ${status}; ${detail})`,
        'throttled-ip',
        status,
        code,
      );
    }
    if (status === 429 || code === 4 || code === 5) {
      return new BingApiError(
        `Bing ${method} was throttled (${detail}). Wait a while before retrying; quotas reset daily (midnight UTC for URL submission).`,
        'throttled',
        status,
        code,
      );
    }
    if (code === 3 || code === 14 || status === 401 || status === 403) {
      return new BingApiError(
        `Bing ${method} was not authorized (${detail}). Check that BING_API_KEY is the current key from Bing Webmaster Tools ` +
          '(Settings > API access) and that the site is verified for that account.',
        'auth',
        status,
        code,
      );
    }
    if (code === 11 || code === 10 || status === 404) {
      return new BingApiError(
        `Bing ${method}: not found (${detail}). Use bing_list_sites for the exact site URL registered in Bing Webmaster Tools.`,
        'not-found',
        status,
        code,
      );
    }
    if (code === 7 || code === 8 || status === 400) {
      return new BingApiError(`Bing ${method} rejected the request (${detail}).`, 'invalid', status, code);
    }
    return new BingApiError(`Bing ${method} failed (HTTP ${status}; ${detail}).`, 'api', status, code);
  }
}

interface Fault {
  ErrorCode?: number;
  Message?: string;
}

function asFault(json: unknown): Fault | null {
  if (!json || typeof json !== 'object' || Array.isArray(json) || 'd' in json) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.ErrorCode !== 'number' && typeof o.Message !== 'string') return null;
  const f: Fault = {};
  if (typeof o.ErrorCode === 'number') f.ErrorCode = o.ErrorCode;
  if (typeof o.Message === 'string') f.Message = o.Message;
  return f;
}

// ---------- value normalization ----------

const WCF_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
/** ISO 8601 date or date-time; group 1 is the calendar date as written, group 3 the zone (absent = no zone). */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

export interface BingDate {
  /** Instant in UTC, ISO 8601. */
  iso: string;
  /** Calendar date (YYYY-MM-DD) in the offset Bing attached, or UTC when none. */
  date: string;
}

/**
 * Parse a WCF JSON date ("/Date(ms)/" or "/Date(ms-0700)/"). The millisecond
 * value is UTC; the optional offset only says which local calendar day Bing
 * meant, so `date` uses it. ISO 8601 strings keep the calendar date as
 * written (that is the day in their own offset); one without a zone is read
 * as UTC so the result does not depend on the server's time zone.
 * DateTime.MinValue and unparseable values give null.
 */
export function parseBingDate(value: unknown): BingDate | null {
  if (typeof value !== 'string') return null;
  const m = WCF_DATE.exec(value.trim());
  if (m) {
    const ms = Number(m[1]);
    let offsetMin = 0;
    if (m[2]) {
      const sign = m[2].startsWith('-') ? -1 : 1;
      offsetMin = sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5)));
    }
    const instant = new Date(ms);
    if (!Number.isFinite(ms) || Number.isNaN(instant.getTime()) || instant.getUTCFullYear() <= 1) return null;
    return { iso: instant.toISOString(), date: new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10) };
  }
  const iso = ISO_DATE.exec(value.trim());
  if (!iso) return null;
  const day = iso[1]!;
  const zone = iso[3] ?? 'Z';
  const instant = new Date(`${day}${iso[2] ?? 'T00:00:00'}${zone.toUpperCase()}`);
  if (Number.isNaN(instant.getTime()) || instant.getUTCFullYear() <= 1 || !isCalendarDate(day)) return null;
  return { iso: instant.toISOString(), date: day };
}

/** True for a real YYYY-MM-DD calendar date (rejects 2025-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const bingIso = (v: unknown): string | null => parseBingDate(v)?.iso ?? null;
export const bingDay = (v: unknown): string | null => parseBingDate(v)?.date ?? null;

/** UrlWithCrawlIssues.CrawlIssues flag values. */
export const CRAWL_ISSUE_FLAGS: readonly [number, string][] = [
  [1, 'Code301'],
  [2, 'Code302'],
  [4, 'Code4xx'],
  [8, 'Code5xx'],
  [16, 'BlockedByRobotsTxt'],
  [32, 'ContainsMalware'],
  [64, 'ImportantUrlBlockedByRobotsTxt'],
  [128, 'DnsErrors'],
  [256, 'TimeOutErrors'],
];

/** Decode the CrawlIssues flags (number, or the enum names as a string). */
export function decodeCrawlIssues(value: unknown): string[] {
  if (typeof value === 'number') {
    const names = CRAWL_ISSUE_FLAGS.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
    const known = CRAWL_ISSUE_FLAGS.reduce((acc, [bit]) => acc | bit, 0);
    if ((value & ~known) !== 0) names.push(`Unknown(${value & ~known})`);
    return names;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(/[\s,]+/).filter((s) => s && s !== 'None');
  }
  return [];
}
