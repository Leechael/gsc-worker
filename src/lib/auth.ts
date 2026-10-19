import type { GoogleConfig } from './config.js';
import {
  CREDENTIALS_MISSING_MESSAGE,
  REFRESH_TOKEN_INVALID_MESSAGE,
  STORED_REFRESH_TOKEN_INVALID_MESSAGE,
} from './errors.js';
import type { GoogleTokenStore, StoredTokenMeta } from './google-oauth/store.js';

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

/** Where the active refresh token comes from: KV (in-Worker flow) wins over env. */
export type TokenSource = 'kv' | 'env' | 'none';

export interface TokenStatus {
  source: TokenSource;
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. */
  clientConfigured: boolean;
  /** Client credentials plus a refresh token are present (does not guarantee they work). */
  configured: boolean;
  /** Metadata of the KV-stored token, when one exists. */
  stored: StoredTokenMeta | null;
  /** Last refresh failure, or a KV read/decrypt failure. No secret values. */
  error: string | null;
}

export interface TokenProviderOptions {
  /** Encrypted KV store from the in-Worker authorization flow. */
  store?: GoogleTokenStore | null;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Renew this long before Google's expiry so concurrent calls never race it. */
const EXPIRY_MARGIN_SEC = 300;

/**
 * Refreshes and caches Google access tokens.
 *
 * - Refresh token precedence: KV-stored token (written by /auth/google) if
 *   present, else GOOGLE_REFRESH_TOKEN from the environment.
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
  private readonly store: GoogleTokenStore | null;

  constructor(
    private readonly google: GoogleConfig,
    // Never default to bare `fetch`: on workerd it must be called with its
    // owner as `this` ("Illegal invocation" otherwise).
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    options: TokenProviderOptions = {},
  ) {
    this.store = options.store ?? null;
  }

  private get clientConfigured(): boolean {
    return Boolean(this.google.clientId && this.google.clientSecret);
  }

  /** Human-readable error from the last failed refresh, if any. */
  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  /** Drop the cached access token and last error (after a new token is stored or revoked). */
  reset(): void {
    this.cached = null;
    this.lastError = null;
  }

  /** Active token source and health, without secret values. */
  async status(): Promise<TokenStatus> {
    let stored: StoredTokenMeta | null = null;
    let storeError: string | null = null;
    if (this.store) {
      try {
        stored = await this.store.loadMeta();
      } catch (e) {
        storeError = e instanceof Error ? e.message : String(e);
      }
    }
    // An unreadable KV record still counts as the KV source: falling back to
    // env would silently use a different account than the one authorized.
    const source: TokenSource = stored || storeError ? 'kv' : this.google.refreshToken ? 'env' : 'none';
    return {
      source,
      clientConfigured: this.clientConfigured,
      configured: this.clientConfigured && source !== 'none',
      stored,
      error: storeError ?? this.lastError,
    };
  }

  async getAccessToken(): Promise<string> {
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

  private async resolveRefreshToken(): Promise<{ source: 'kv' | 'env'; token: string } | null> {
    if (this.store) {
      let stored: Awaited<ReturnType<GoogleTokenStore['loadRefreshToken']>>;
      try {
        stored = await this.store.loadRefreshToken();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError = msg;
        throw new TokenRefreshError(msg);
      }
      if (stored) return { source: 'kv', token: stored.refreshToken };
    }
    if (this.google.refreshToken) return { source: 'env', token: this.google.refreshToken };
    return null;
  }

  private async refresh(): Promise<string> {
    const resolved = await this.resolveRefreshToken();
    if (!this.clientConfigured || !resolved) {
      throw new TokenRefreshError(CREDENTIALS_MISSING_MESSAGE);
    }
    const body = new URLSearchParams({
      client_id: this.google.clientId!,
      client_secret: this.google.clientSecret!,
      refresh_token: resolved.token,
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
        ? resolved.source === 'kv'
          ? STORED_REFRESH_TOKEN_INVALID_MESSAGE
          : REFRESH_TOKEN_INVALID_MESSAGE
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
