import type { GoogleConfig } from './config.js';
import {
  CREDENTIALS_MISSING_MESSAGE,
  REFRESH_TOKEN_INVALID_MESSAGE,
  STORED_REFRESH_TOKEN_INVALID_MESSAGE,
  STORED_TOKEN_CLIENT_MISMATCH_MESSAGE,
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
  /** Clock, injectable for tests. */
  now?: () => number;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Renew this long before Google's expiry so concurrent calls never race it. */
const EXPIRY_MARGIN_SEC = 300;
/**
 * How long KV token metadata is trusted before it is read again. Bounds how
 * long another isolate keeps using an access token minted from a replaced or
 * revoked refresh token, and how often /health touches KV.
 */
const STORED_META_TTL_MS = 30_000;

interface MetaSnapshot {
  meta: StoredTokenMeta | null;
  error: string | null;
  atMs: number;
}

/**
 * Refreshes and caches Google access tokens.
 *
 * - Refresh token precedence: KV-stored token (written by /auth/google) if
 *   present, else GOOGLE_REFRESH_TOKEN from the environment.
 * - In-memory cache with a safety margin (a 1h token is cached for ~55 min),
 *   keyed by which refresh token minted it: when the KV record changes
 *   (re-authorized or disconnected, possibly in another isolate) the cached
 *   access token is dropped within STORED_META_TTL_MS.
 * - Concurrent expiry triggers a single token request (in-flight dedup,
 *   plan §7-10); every caller awaits the same promise.
 * - `invalid_grant` is surfaced as an actionable TokenRefreshError and
 *   remembered so /health can report token availability (plan §6.2).
 */
export class TokenProvider {
  private cached: { accessToken: string; expiresAtMs: number; fingerprint: string } | null = null;
  private inflight: Promise<string> | null = null;
  private lastError: string | null = null;
  private metaSnapshot: MetaSnapshot | null = null;
  /** Bumped by reset(); a refresh started before a reset must not repopulate the cache. */
  private generation = 0;
  private readonly store: GoogleTokenStore | null;
  private readonly now: () => number;

  constructor(
    private readonly google: GoogleConfig,
    // Never default to bare `fetch`: on workerd it must be called with its
    // owner as `this` ("Illegal invocation" otherwise).
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    options: TokenProviderOptions = {},
  ) {
    this.store = options.store ?? null;
    this.now = options.now ?? Date.now;
  }

  private get clientConfigured(): boolean {
    return Boolean(this.google.clientId && this.google.clientSecret);
  }

  /** Human-readable error from the last failed refresh, if any. */
  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  /** Drop all cached state (after a new token is stored or revoked in this isolate). */
  reset(): void {
    this.cached = null;
    this.lastError = null;
    this.metaSnapshot = null;
    this.generation++;
  }

  /** Drop only the access token, e.g. after Google rejected it with 401. */
  invalidateAccessToken(): void {
    this.cached = null;
  }

  private async storedMeta(fresh = false): Promise<MetaSnapshot> {
    const snap = this.metaSnapshot;
    if (!fresh && snap && this.now() - snap.atMs < STORED_META_TTL_MS) return snap;
    let meta: StoredTokenMeta | null = null;
    let error: string | null = null;
    try {
      meta = (await this.store?.loadMeta()) ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.metaSnapshot = { meta, error, atMs: this.now() };
    return this.metaSnapshot;
  }

  /** Identifies the refresh token currently in effect. */
  private async currentFingerprint(): Promise<string> {
    if (!this.store) return 'env';
    const { meta, error } = await this.storedMeta();
    if (meta) return fingerprintOf(meta);
    return error ? 'kv:unreadable' : 'env';
  }

  /**
   * Active token source and health, without secret values. KV metadata may
   * be up to STORED_META_TTL_MS old unless `fresh` is set.
   */
  async status(opts: { fresh?: boolean } = {}): Promise<TokenStatus> {
    let stored: StoredTokenMeta | null = null;
    let storeError: string | null = null;
    if (this.store) {
      ({ meta: stored, error: storeError } = await this.storedMeta(opts.fresh));
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
    if (this.cached && this.cached.expiresAtMs > this.now()) {
      if (this.cached.fingerprint === (await this.currentFingerprint())) {
        return this.cached.accessToken;
      }
      this.cached = null;
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

  private async resolveRefreshToken(): Promise<{ source: 'kv' | 'env'; token: string; fingerprint: string } | null> {
    if (this.store) {
      let stored: Awaited<ReturnType<GoogleTokenStore['loadRefreshToken']>>;
      try {
        stored = await this.store.loadRefreshToken();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError = msg;
        throw new TokenRefreshError(msg);
      }
      this.metaSnapshot = { meta: stored?.meta ?? null, error: null, atMs: this.now() };
      if (stored) {
        if (this.google.clientId && stored.meta.clientId !== this.google.clientId) {
          this.lastError = STORED_TOKEN_CLIENT_MISMATCH_MESSAGE;
          throw new TokenRefreshError(STORED_TOKEN_CLIENT_MISMATCH_MESSAGE);
        }
        return { source: 'kv', token: stored.refreshToken, fingerprint: fingerprintOf(stored.meta) };
      }
    }
    if (this.google.refreshToken) return { source: 'env', token: this.google.refreshToken, fingerprint: 'env' };
    return null;
  }

  private async refresh(): Promise<string> {
    const generation = this.generation;
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
    if (generation === this.generation) {
      this.cached = {
        accessToken: data.access_token,
        expiresAtMs: this.now() + Math.max(expiresIn - EXPIRY_MARGIN_SEC, 60) * 1000,
        fingerprint: resolved.fingerprint,
      };
      this.lastError = null;
    }
    return data.access_token;
  }
}

function fingerprintOf(meta: StoredTokenMeta): string {
  return `kv:${meta.clientId}:${meta.storedAt}`;
}
