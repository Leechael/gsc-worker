import { TokenProvider, TokenRefreshError } from './auth.js';

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
}

export interface GscClientOptions {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  /** Max attempts for retryable failures (429 / 5xx / quota). Default 4. */
  maxAttempts?: number;
}

/**
 * Thin REST client for the Search Console API (plan §2: 裸 fetch 直调).
 *
 * Retries 429, 5xx and quota-exceeded responses with exponential backoff +
 * jitter (plan §7-9; refined in M2 with per-quota guidance).
 */
export class GscClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;

  constructor(private readonly opts: GscClientOptions) {
    // See TokenProvider: bare `fetch` as a default breaks on workerd.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  async request<T>(path: string, options: GscRequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body } = options;
    const url = new URL(`${GSC_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      // null means the argument was omitted.
      if (v != null) url.searchParams.set(k, v);
    }

    const accessToken = await this.opts.tokenProvider.getAccessToken();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let res: Response;
      try {
        const init: RequestInit = {
          method,
          headers: { Authorization: `Bearer ${accessToken}` },
        };
        if (body !== undefined) {
          init.headers = { ...init.headers, 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        res = await this.fetchImpl(url, init);
      } catch (e) {
        // Network-level failure — retryable.
        lastError = e instanceof Error ? e : new Error(String(e));
        await backoff(attempt);
        continue;
      }

      if (res.ok) {
        // Success with no body (204, or 200-empty as some GSC endpoints return).
        if (res.status === 204) return undefined as T;
        return (await res.json().catch(() => undefined)) as T;
      }

      const errBody = (await res.json().catch(() => null)) as GoogleErrorBody | null;
      const reason = errBody?.error?.details?.find((d) => d.reason)?.reason ?? null;
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;

      if (isRetryable(res.status, message) && attempt < this.maxAttempts - 1) {
        await backoff(attempt);
        continue;
      }
      throw new GscApiError(res.status, message, reason);
    }
    throw lastError ?? new GscApiError(500, 'request failed');
  }
}

function isRetryable(status: number, message: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  return /quota exceeded/i.test(message);
}

function backoff(attempt: number): Promise<void> {
  const base = 1000 * 2 ** attempt;
  const jitter = Math.random() * 500;
  return new Promise((r) => setTimeout(r, base + jitter));
}

/** Re-export for tools that want to narrow error handling. */
export { TokenRefreshError };
