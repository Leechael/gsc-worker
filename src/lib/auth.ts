import type { GoogleConfig } from './config.js';
import { CREDENTIALS_MISSING_MESSAGE, REFRESH_TOKEN_INVALID_MESSAGE } from './errors.js';

/** Refresh-token exchange failed; `cause` distinguishes invalid_grant. */
export class TokenRefreshError extends Error {
  readonly invalidGrant: boolean;
  constructor(message: string, invalidGrant = false) {
    super(message);
    this.name = 'TokenRefreshError';
    this.invalidGrant = invalidGrant;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Renew this long before Google's expiry so concurrent calls never race it. */
const EXPIRY_MARGIN_SEC = 300;

/**
 * Refreshes and caches Google access tokens.
 *
 * - In-memory cache with a safety margin (a 1h token is cached for ~55 min).
 * - Concurrent expiry triggers a single token request (in-flight dedup,
 *   plan §7-10); every caller awaits the same promise.
 * - `invalid_grant` is surfaced as an actionable TokenRefreshError and
 *   remembered so /health can report token availability (plan §6.2).
 */
export class TokenProvider {
  private cached: { accessToken: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly google: GoogleConfig,
    // Never default to bare `fetch`: on workerd it must be called with its
    // owner as `this` ("Illegal invocation" otherwise).
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** All three credential parts present (does not guarantee the token works). */
  get configured(): boolean {
    return Boolean(this.google.clientId && this.google.clientSecret && this.google.refreshToken);
  }

  /** Human-readable error from the last failed refresh, if any. */
  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  async getAccessToken(): Promise<string> {
    if (!this.configured) {
      throw new TokenRefreshError(CREDENTIALS_MISSING_MESSAGE);
    }
    if (this.cached && this.cached.expiresAtMs > Date.now()) {
      return this.cached.accessToken;
    }
    // In-flight dedup: concurrent callers share one refresh.
    this.inflight ??= this.refresh()
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Test helper / health probe entry point. */
  async probe(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.google.clientId!,
      client_secret: this.google.clientSecret!,
      refresh_token: this.google.refreshToken!,
      grant_type: 'refresh_token',
    });

    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (e) {
      const msg = `Failed to reach Google token endpoint: ${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      throw new TokenRefreshError(msg);
    }

    const data = (await res.json().catch(() => null)) as (TokenResponse & { error?: string; error_description?: string }) | null;

    if (!res.ok || !data?.access_token) {
      const errCode = data?.error ?? `HTTP ${res.status}`;
      const invalidGrant = errCode === 'invalid_grant';
      const msg = invalidGrant
        ? REFRESH_TOKEN_INVALID_MESSAGE
        : `Google token refresh failed (${errCode}): ${data?.error_description ?? 'no details'}`;
      this.lastError = msg;
      throw new TokenRefreshError(msg, invalidGrant);
    }

    const expiresIn = data.expires_in ?? 3600;
    this.cached = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + Math.max(expiresIn - EXPIRY_MARGIN_SEC, 60) * 1000,
    };
    this.lastError = null;
    return data.access_token;
  }
}
