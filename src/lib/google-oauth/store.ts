import { decryptString, encryptString, importEncryptionKey, type AesKey } from './crypto.js';

/** The subset of the Workers KV namespace API this module uses. */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function isKvNamespace(value: unknown): value is KvNamespaceLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.get === 'function' && typeof v.put === 'function' && typeof v.delete === 'function';
}

/** KV key layout. Single Google account per deployment. */
export const KV_KEYS = {
  refreshToken: 'google:refresh-token',
  oauthState: (state: string) => `google:oauth-state:${state}`,
} as const;

/** KV's minimum expirationTtl is 60s; consent normally takes well under 10 minutes. */
export const OAUTH_STATE_TTL_SEC = 600;

const REFRESH_TOKEN_AAD = 'gsc-mcp-ts:google-refresh-token:v1';
const stateAad = (state: string) => `gsc-mcp-ts:oauth-state:v1:${state}`;

/** Non-secret metadata stored next to the encrypted refresh token. */
export interface StoredTokenMeta {
  scope: string;
  clientId: string;
  email?: string;
  storedAt: string;
}

interface StoredTokenRecord {
  v: 1;
  refresh_token: string;
  scope: string;
  client_id: string;
  email?: string;
  stored_at: string;
}

/** Pending authorization request, keyed by the `state` parameter. */
export interface OAuthStateRecord {
  codeVerifier: string;
  /** Identity (Access email / service token / static bearer) that started the flow. */
  principal: string;
  redirectUri: string;
  createdAt: string;
}

export type TakeStateResult =
  | { status: 'ok'; record: OAuthStateRecord }
  | { status: 'missing' }
  | { status: 'mismatch' };

export class StoredTokenUnreadableError extends Error {
  constructor(detail: string) {
    super(
      `The Google token stored in KV cannot be decrypted (${detail}). ` +
        'TOKEN_ENCRYPTION_KEY probably changed since it was stored. Open /auth/google on this deployment to authorize again.',
    );
    this.name = 'StoredTokenUnreadableError';
  }
}

/**
 * Encrypted Google token storage on Workers KV.
 *
 * Only the refresh token and the pending PKCE verifier are secret; both are
 * AES-GCM encrypted. Scope, email, client id and timestamp stay readable so
 * status can be shown without decrypting.
 */
export class GoogleTokenStore {
  private keyPromise: Promise<AesKey> | null = null;

  constructor(
    private readonly kv: KvNamespaceLike,
    private readonly rawKey: string,
  ) {}

  private key(): Promise<AesKey> {
    this.keyPromise ??= importEncryptionKey(this.rawKey);
    return this.keyPromise;
  }

  private async readRecord(): Promise<StoredTokenRecord | null> {
    const raw = await this.kv.get(KV_KEYS.refreshToken);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoredTokenUnreadableError('record is not JSON');
    }
    const rec = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<StoredTokenRecord>;
    if (
      rec.v !== 1 ||
      typeof rec.refresh_token !== 'string' ||
      typeof rec.scope !== 'string' ||
      typeof rec.client_id !== 'string' ||
      typeof rec.stored_at !== 'string' ||
      (rec.email !== undefined && typeof rec.email !== 'string')
    ) {
      throw new StoredTokenUnreadableError('unrecognized record format');
    }
    return rec as StoredTokenRecord;
  }

  async loadMeta(): Promise<StoredTokenMeta | null> {
    const rec = await this.readRecord();
    return rec ? toMeta(rec) : null;
  }

  /** Decrypted refresh token plus metadata, or null when nothing is stored. */
  async loadRefreshToken(): Promise<{ refreshToken: string; meta: StoredTokenMeta } | null> {
    const rec = await this.readRecord();
    if (!rec) return null;
    let refreshToken: string;
    try {
      refreshToken = await decryptString(await this.key(), rec.refresh_token, REFRESH_TOKEN_AAD);
    } catch (e) {
      throw new StoredTokenUnreadableError(e instanceof Error ? e.message : String(e));
    }
    return { refreshToken, meta: toMeta(rec) };
  }

  async save(refreshToken: string, meta: Omit<StoredTokenMeta, 'storedAt'>): Promise<StoredTokenMeta> {
    const rec: StoredTokenRecord = {
      v: 1,
      refresh_token: await encryptString(await this.key(), refreshToken, REFRESH_TOKEN_AAD),
      scope: meta.scope,
      client_id: meta.clientId,
      ...(meta.email ? { email: meta.email } : {}),
      stored_at: new Date().toISOString(),
    };
    await this.kv.put(KV_KEYS.refreshToken, JSON.stringify(rec));
    return toMeta(rec);
  }

  async clear(): Promise<void> {
    await this.kv.delete(KV_KEYS.refreshToken);
  }

  async putState(state: string, record: OAuthStateRecord): Promise<void> {
    const blob = await encryptString(await this.key(), JSON.stringify(record), stateAad(state));
    await this.kv.put(KV_KEYS.oauthState(state), blob, { expirationTtl: OAUTH_STATE_TTL_SEC });
  }

  /**
   * Consume a pending state (single use) on behalf of `principal`.
   *
   * - `missing`: unknown, expired, already used, or unreadable. KV evicts
   *   expired keys lazily, so the creation time is checked too.
   * - `mismatch`: started by another identity. The record is left in place so
   *   a different authenticated user cannot burn someone else's flow.
   *
   * KV has no compare-and-delete: two concurrent callbacks can both read the
   * record, but Google accepts an authorization code only once.
   */
  async takeState(state: string, principal: string): Promise<TakeStateResult> {
    const key = KV_KEYS.oauthState(state);
    const blob = await this.kv.get(key);
    if (blob === null) return { status: 'missing' };
    let rec: OAuthStateRecord;
    try {
      rec = JSON.parse(await decryptString(await this.key(), blob, stateAad(state))) as OAuthStateRecord;
    } catch {
      await this.kv.delete(key);
      return { status: 'missing' };
    }
    const ageMs = Date.now() - Date.parse(rec.createdAt);
    if (!(ageMs >= 0 && ageMs <= OAUTH_STATE_TTL_SEC * 1000)) {
      await this.kv.delete(key);
      return { status: 'missing' };
    }
    if (rec.principal !== principal) return { status: 'mismatch' };
    await this.kv.delete(key);
    return { status: 'ok', record: rec };
  }
}

function toMeta(rec: StoredTokenRecord): StoredTokenMeta {
  return {
    scope: rec.scope,
    clientId: rec.client_id,
    ...(rec.email ? { email: rec.email } : {}),
    storedAt: rec.stored_at,
  };
}
