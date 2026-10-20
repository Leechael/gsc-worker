/**
 * Yandex Webmaster API v4 client (https://yandex.com/dev/webmaster/doc/en/).
 *
 * fetch only, so it runs on Workers, Node and stdio alike. The OAuth token is
 * sent as `Authorization: OAuth <token>` and is never logged or echoed into
 * error messages.
 *
 * One client is built per MCP server instance, i.e. per request on the HTTP
 * entries; the user_id (GET /user) and the host list are resolved lazily and
 * cached for that lifetime only.
 */

export const YANDEX_API_BASE = 'https://api.webmaster.yandex.net/v4';

/** Structured error from the Yandex Webmaster API (body: error_code, error_message, ...). */
export class YandexApiError extends Error {
  readonly status: number;
  /** `error_code` from the response body, e.g. QUOTA_EXCEEDED or HOST_NOT_VERIFIED. */
  readonly code: string | null;
  /** 429 bodies: maximum number of requests per day. */
  readonly dailyQuota: number | null;
  /** 429 bodies: time when the new quota starts. */
  readonly exceededUntil: string | null;
  constructor(status: number, message: string, code: string | null = null, extra: { dailyQuota?: number | null; exceededUntil?: string | null } = {}) {
    super(message);
    this.name = 'YandexApiError';
    this.status = status;
    this.code = code;
    this.dailyQuota = extra.dailyQuota ?? null;
    this.exceededUntil = extra.exceededUntil ?? null;
  }
}

interface YandexErrorBody {
  error_code?: string;
  error_message?: string;
  daily_quota?: number;
  exceeded_until?: string;
}

export interface YandexHost {
  host_id: string;
  ascii_host_url?: string;
  unicode_host_url?: string;
  verified?: boolean;
  main_mirror?: { host_id?: string; ascii_host_url?: string; unicode_host_url?: string; verified?: boolean } | null;
}

export type YandexQueryValue = string | number | readonly string[] | null | undefined;

export interface YandexRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, YandexQueryValue>;
  body?: unknown;
}

export interface YandexClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  /** Attempts for network errors and 5xx responses. 429 is never retried: Yandex reports a daily quota. Default 3. */
  maxAttempts?: number;
  /** Base delay between retries in ms (doubles each time). Default 500. */
  retryDelayMs?: number;
}

/** `https:example.com:443`, the host_id format returned by GET /user/{user-id}/hosts. */
const HOST_ID_RE = /^https?:[^/:\s]+:\d+$/i;

/** Encode one path segment; host and sitemap IDs contain ':' which is legal in a path and kept as is. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':');
}

function normalizeHostUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

export class YandexWebmasterClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private userIdPromise: Promise<number> | null = null;
  private hostsPromise: Promise<YandexHost[]> | null = null;

  constructor(opts: YandexClientOptions) {
    this.token = opts.token;
    // A bare `fetch` reference as default breaks on workerd (see TokenProvider).
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  /** GET /user, cached for this client's lifetime. A failure is not cached. */
  userId(): Promise<number> {
    if (!this.userIdPromise) {
      this.userIdPromise = this.request<{ user_id?: number }>('/user').then((data) => {
        if (typeof data?.user_id !== 'number') {
          throw new YandexApiError(502, 'GET /user returned no user_id');
        }
        return data.user_id;
      });
      this.userIdPromise.catch(() => {
        this.userIdPromise = null;
      });
    }
    return this.userIdPromise;
  }

  /** Request a path under /user/{user-id}. */
  async userRequest<T>(path: string, options: YandexRequestOptions = {}): Promise<T> {
    const uid = await this.userId();
    return this.request<T>(`/user/${uid}${path}`, options);
  }

  /** Request a path under /user/{user-id}/hosts/{host-id}. */
  async hostRequest<T>(host: string, path: string, options: YandexRequestOptions = {}): Promise<T> {
    const hostId = await this.resolveHostId(host);
    return this.userRequest<T>(`/hosts/${pathSegment(hostId)}${path}`, options);
  }

  /** GET /user/{user-id}/hosts, cached for this client's lifetime. */
  listHosts(): Promise<YandexHost[]> {
    if (!this.hostsPromise) {
      this.hostsPromise = this.userRequest<{ hosts?: YandexHost[] }>('/hosts').then((d) => d?.hosts ?? []);
      this.hostsPromise.catch(() => {
        this.hostsPromise = null;
      });
    }
    return this.hostsPromise;
  }

  /**
   * Accept a host_id (`https:example.com:443`) as is; otherwise match a site
   * URL against ascii_host_url / unicode_host_url from the host list rather
   * than guessing the host_id format.
   */
  async resolveHostId(host: string): Promise<string> {
    const value = host.trim();
    if (HOST_ID_RE.test(value)) return value;
    const wanted = normalizeHostUrl(value);
    const hosts = await this.listHosts();
    const match = hosts.find((h) =>
      [h.ascii_host_url, h.unicode_host_url].some((u) => typeof u === 'string' && normalizeHostUrl(u) === wanted),
    );
    if (match) return match.host_id;
    const known = hosts.map((h) => h.ascii_host_url ?? h.host_id).slice(0, 20).join(', ');
    throw new YandexApiError(
      404,
      `Site '${value}' is not in this Yandex Webmaster account. Pass a host_id from yandex_list_hosts ` +
        `(format https:example.com:443) or the exact site URL including the protocol.` +
        (known ? ` Known sites: ${known}` : ' The account has no sites.'),
      'HOST_NOT_FOUND',
    );
  }

  async request<T>(path: string, options: YandexRequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body } = options;
    const url = new URL(`${YANDEX_API_BASE}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item);
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `OAuth ${this.token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await this.sleep(attempt - 1);
      let res: Response;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        lastError = new YandexApiError(0, `network error calling Yandex Webmaster: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (text.trim() === '') return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new YandexApiError(502, 'Yandex Webmaster returned a non-JSON response');
        }
      }
      const errBody = (await res.json().catch(() => null)) as YandexErrorBody | null;
      const err = new YandexApiError(
        res.status,
        errBody?.error_message ?? `HTTP ${res.status}`,
        errBody?.error_code ?? null,
        {
          dailyQuota: typeof errBody?.daily_quota === 'number' ? errBody.daily_quota : null,
          exceededUntil: typeof errBody?.exceeded_until === 'string' ? errBody.exceeded_until : null,
        },
      );
      if (res.status >= 500) {
        lastError = err;
        continue;
      }
      throw err;
    }
    throw lastError ?? new YandexApiError(500, 'request failed');
  }

  private sleep(n: number): Promise<void> {
    const ms = this.retryDelayMs * 2 ** n;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}

/**
 * Yandex timestamps look like `2016-01-01T00:00:00,000+0300`; turn them into
 * ISO 8601 (`2016-01-01T00:00:00.000+03:00`) keeping the original offset.
 * Values that do not parse are returned unchanged.
 */
export function normalizeYandexDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const iso = raw.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d+)/, '$1.$2').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Number.isNaN(new Date(iso).getTime()) ? raw : iso;
}
