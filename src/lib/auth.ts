import type { GoogleConfig } from './config.js';
import {
  CREDENTIALS_MISSING_MESSAGE,
  REFRESH_TOKEN_INVALID_MESSAGE,
  STORED_REFRESH_TOKEN_INVALID_MESSAGE,
  STORED_TOKEN_CLIENT_MISMATCH_MESSAGE,
} from './errors.js';
import type { GoogleTokenStore, StoredAccount, StoredTokenMeta } from './google-oauth/store.js';

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

/** Where the default account's refresh token comes from: KV (in-Worker flow) first, then env. */
export type TokenSource = 'kv' | 'env' | 'none';

/** Account id of GOOGLE_REFRESH_TOKEN from the environment. */
export const ENV_ACCOUNT_ID = 'env';

/** One connected Google account, without secret values. */
export interface AccountStatus {
  /** Lowercased email for KV accounts, LEGACY_ACCOUNT_ID for an email-less KV record, ENV_ACCOUNT_ID for env. */
  id: string;
  email: string | null;
  source: 'kv' | 'env';
  /** KV metadata; null for env or when the record cannot be read. */
  stored: StoredTokenMeta | null;
  /** Read/decrypt failure, client mismatch, or the last refresh failure. */
  error: string | null;
  /** Client credentials are set and no error is known. Does not guarantee the token works. */
  available: boolean;
}

export interface TokenStatus {
  /** Source of the default account (the first KV account, else env). */
  source: TokenSource;
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. */
  clientConfigured: boolean;
  /** Client credentials plus a refresh token are present (does not guarantee they work). */
  configured: boolean;
  /** Metadata of the default KV-stored token, when one exists. */
  stored: StoredTokenMeta | null;
  /** Error of the default account. No secret values. */
  error: string | null;
  /** Every connected account, default first. */
  accounts: AccountStatus[];
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
 * How long the KV account list is trusted before it is read again. Bounds how
 * long another isolate keeps using an access token minted from a replaced or
 * revoked refresh token, and how often /health touches KV.
 */
const STORED_META_TTL_MS = 30_000;

interface AccountsSnapshot {
  accounts: StoredAccount[];
  /** The account list itself could not be read. */
  error: string | null;
  atMs: number;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  fingerprint: string;
}

/**
 * Refreshes and caches Google access tokens for every connected account.
 *
 * - Accounts: each KV-stored account (written by /auth/google, one per Google
 *   email) plus GOOGLE_REFRESH_TOKEN from the environment as one more
 *   account. Calls without an account id use the default account: the first
 *   KV account, else env.
 * - Per-account in-memory cache with a safety margin (a 1h token is cached
 *   for ~55 min), keyed by which refresh token minted it: when an account's
 *   KV record changes (re-authorized or removed, possibly in another isolate)
 *   its cached access token is dropped within STORED_META_TTL_MS.
 * - Concurrent expiry triggers a single token request per account (in-flight
 *   dedup, plan §7-10); every caller awaits the same promise.
 * - `invalid_grant` is surfaced as an actionable TokenRefreshError and
 *   remembered per account so /health can report availability (plan §6.2).
 */
export class TokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly lastErrors = new Map<string, string>();
  private snapshot: AccountsSnapshot | null = null;
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

  /** Human-readable error from the default account's last failed refresh, if any. */
  get lastErrorMessage(): string | null {
    const id = this.snapshot?.accounts[0]?.id ?? ENV_ACCOUNT_ID;
    return this.lastErrors.get(id) ?? null;
  }

  /** Drop all cached state (after a token is stored or removed in this isolate). */
  reset(): void {
    this.cache.clear();
    this.lastErrors.clear();
    this.snapshot = null;
    this.generation++;
  }

  /** Drop an account's access token (all accounts when omitted), e.g. after Google rejected it with 401. */
  invalidateAccessToken(accountId?: string): void {
    if (accountId === undefined) this.cache.clear();
    else this.cache.delete(accountId);
  }

  private async storedAccounts(fresh = false): Promise<AccountsSnapshot> {
    const snap = this.snapshot;
    if (!fresh && snap && this.now() - snap.atMs < STORED_META_TTL_MS) return snap;
    let accounts: StoredAccount[] = [];
    let error: string | null = null;
    if (this.store) {
      try {
        // Decrypts each token, not just its metadata: a token that no longer
        // decrypts (TOKEN_ENCRYPTION_KEY changed) must show up as unavailable.
        accounts = await this.store.listAccounts();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    this.snapshot = { accounts, error, atMs: this.now() };
    return this.snapshot;
  }

  /** Account ids in order, default first. Cheap: uses the cached KV snapshot. */
  async accountIds(opts: { fresh?: boolean } = {}): Promise<string[]> {
    const { accounts } = await this.storedAccounts(opts.fresh);
    const ids = accounts.map((a) => a.id);
    if (this.google.refreshToken) ids.push(ENV_ACCOUNT_ID);
    return ids;
  }

  /** Every connected account with its health, default first. No secret values. */
  async accounts(opts: { fresh?: boolean } = {}): Promise<AccountStatus[]> {
    const { accounts } = await this.storedAccounts(opts.fresh);
    const out: AccountStatus[] = accounts.map((a) => {
      const mismatch = a.meta && this.google.clientId && a.meta.clientId !== this.google.clientId
        ? STORED_TOKEN_CLIENT_MISMATCH_MESSAGE
        : null;
      const error = a.error ?? mismatch ?? this.lastErrors.get(a.id) ?? null;
      return {
        id: a.id,
        email: a.meta?.email ?? null,
        source: 'kv' as const,
        stored: a.meta,
        error,
        available: this.clientConfigured && error === null,
      };
    });
    if (this.google.refreshToken) {
      const error = this.lastErrors.get(ENV_ACCOUNT_ID) ?? null;
      out.push({ id: ENV_ACCOUNT_ID, email: null, source: 'env', stored: null, error, available: this.clientConfigured && error === null });
    }
    return out;
  }

  /** Identifies the refresh token currently in effect for an account. */
  private async currentFingerprint(accountId: string): Promise<string> {
    if (accountId === ENV_ACCOUNT_ID) return 'env';
    const { accounts, error } = await this.storedAccounts();
    const a = accounts.find((x) => x.id === accountId);
    if (a?.meta) return fingerprintOf(a.meta);
    return a?.error || error ? 'kv:unreadable' : 'kv:missing';
  }

  /**
   * Default account's source and health plus every account, without secret
   * values. KV data may be up to STORED_META_TTL_MS old unless `fresh` is set.
   */
  async status(opts: { fresh?: boolean } = {}): Promise<TokenStatus> {
    const snap = await this.storedAccounts(opts.fresh);
    const accounts = await this.accounts();
    const first = accounts[0];
    // An unreadable KV list still counts as the KV source: falling back to
    // env would silently use a different account than the one authorized.
    const source: TokenSource = snap.error ? 'kv' : first?.source ?? 'none';
    const firstKv = accounts.find((a) => a.source === 'kv');
    return {
      source,
      clientConfigured: this.clientConfigured,
      configured: this.clientConfigured && source !== 'none',
      stored: firstKv?.stored ?? null,
      error: snap.error ?? first?.error ?? null,
      accounts,
    };
  }

  /** Access token for an account (default account when omitted). */
  async getAccessToken(accountId?: string): Promise<string> {
    let id = accountId;
    if (id === undefined) {
      const snap = await this.storedAccounts();
      if (snap.error) throw new TokenRefreshError(snap.error);
      id = (await this.accountIds())[0];
      if (id === undefined) throw new TokenRefreshError(CREDENTIALS_MISSING_MESSAGE);
    }
    const cached = this.cache.get(id);
    if (cached && cached.expiresAtMs > this.now()) {
      // reset() or invalidateAccessToken() may run while KV is awaited.
      const fingerprint = await this.currentFingerprint(id);
      if (this.cache.get(id) === cached && cached.fingerprint === fingerprint) {
        return cached.accessToken;
      }
      if (this.cache.get(id) === cached) this.cache.delete(id);
    }
    // In-flight dedup: concurrent callers for one account share one refresh.
    let pending = this.inflight.get(id);
    if (!pending) {
      const key = id;
      pending = this.refresh(key).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Test helper / health probe entry point (default account). */
  async probe(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  private fail(accountId: string, message: string, invalidGrant = false): never {
    this.lastErrors.set(accountId, message);
    throw new TokenRefreshError(message, invalidGrant);
  }

  private async resolveRefreshToken(accountId: string): Promise<{ source: 'kv' | 'env'; token: string; fingerprint: string } | null> {
    if (accountId === ENV_ACCOUNT_ID) {
      return this.google.refreshToken ? { source: 'env', token: this.google.refreshToken, fingerprint: 'env' } : null;
    }
    if (!this.store) return null;
    let stored: Awaited<ReturnType<GoogleTokenStore['loadRefreshToken']>>;
    try {
      stored = await this.store.loadRefreshToken(accountId);
    } catch (e) {
      this.fail(accountId, e instanceof Error ? e.message : String(e));
    }
    if (!stored) {
      this.fail(accountId, `Google account ${accountId} is no longer connected. Open https://<this-worker-host>/auth/google to connect it again.`);
    }
    if (this.google.clientId && stored.meta.clientId !== this.google.clientId) {
      this.fail(accountId, STORED_TOKEN_CLIENT_MISMATCH_MESSAGE);
    }
    return { source: 'kv', token: stored.refreshToken, fingerprint: fingerprintOf(stored.meta) };
  }

  private async refresh(accountId: string): Promise<string> {
    const generation = this.generation;
    const resolved = await this.resolveRefreshToken(accountId);
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
      this.fail(accountId, `Failed to reach Google token endpoint: ${e instanceof Error ? e.message : String(e)}`);
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
      this.fail(accountId, msg, invalidGrant);
    }

    const expiresIn = data.expires_in ?? 3600;
    if (generation === this.generation) {
      this.cache.set(accountId, {
        accessToken: data.access_token,
        expiresAtMs: this.now() + Math.max(expiresIn - EXPIRY_MARGIN_SEC, 60) * 1000,
        fingerprint: resolved.fingerprint,
      });
      this.lastErrors.delete(accountId);
    }
    return data.access_token;
  }
}

function fingerprintOf(meta: StoredTokenMeta): string {
  return `kv:${meta.clientId}:${meta.storedAt}`;
}
