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

/**
 * KV key layout. Several Google accounts per deployment:
 *
 * - `google:account:<email>`: one encrypted record per account, keyed by the
 *   lowercased Google account email.
 * - `google:accounts`: index of account ids (KV has no cheap listing).
 * - `google:refresh-token`: the record written before multi-account support
 *   (and by any save without an email). It is read as one more account; a
 *   record that carries an email is moved to its account key on first read.
 */
export const KV_KEYS = {
  refreshToken: 'google:refresh-token',
  accountIndex: 'google:accounts',
  account: (id: string) => `google:account:${id}`,
  oauthState: (state: string) => `google:oauth-state:${state}`,
} as const;

/** Account id of the record under the legacy key when it has no email. */
export const LEGACY_ACCOUNT_ID = 'default';

/** KV's minimum expirationTtl is 60s; consent normally takes well under 10 minutes. */
export const OAUTH_STATE_TTL_SEC = 600;

const REFRESH_TOKEN_AAD = 'gsc-mcp-ts:google-refresh-token:v1';
/** Bound to the account id so a record cannot be replayed under another account's key. */
const accountAad = (id: string) => `${REFRESH_TOKEN_AAD}:${id}`;
const stateAad = (state: string) => `gsc-mcp-ts:oauth-state:v1:${state}`;

/** Account id for an email: lowercased, trimmed. */
export function accountIdFor(email: string): string {
  return email.trim().toLowerCase();
}

/** Non-secret metadata stored next to the encrypted refresh token. */
export interface StoredTokenMeta {
  scope: string;
  /**
   * Scope string Google returned on the token response. null when the record
   * predates granted-scope tracking (or Google omitted `scope`); write-tier
   * checks then fall back to GSC_SCOPES, and status shows it as unknown.
   */
  grantedScope: string | null;
  clientId: string;
  email?: string;
  storedAt: string;
}

/** One stored account as listed by listAccounts(). Never carries the refresh token. */
export interface StoredAccount {
  /** Lowercased email, or LEGACY_ACCOUNT_ID for an email-less legacy record. */
  id: string;
  meta: StoredTokenMeta | null;
  /** Read or decrypt failure (no secret values). */
  error: string | null;
}

interface StoredTokenRecord {
  v: 1;
  refresh_token: string;
  scope: string;
  granted_scope?: string;
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
  /** Scopes requested at start; the callback requires them. Absent in records from older versions. */
  scopes?: string[];
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

  private async readRecord(key: string): Promise<StoredTokenRecord | null> {
    const raw = await this.kv.get(key);
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
      (rec.email !== undefined && typeof rec.email !== 'string') ||
      (rec.granted_scope !== undefined && typeof rec.granted_scope !== 'string')
    ) {
      throw new StoredTokenUnreadableError('unrecognized record format');
    }
    return rec as StoredTokenRecord;
  }

  private async decrypt(rec: StoredTokenRecord, aad: string): Promise<string> {
    try {
      return await decryptString(await this.key(), rec.refresh_token, aad);
    } catch (e) {
      throw new StoredTokenUnreadableError(e instanceof Error ? e.message : String(e));
    }
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.kv.get(KV_KEYS.accountIndex);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as { v?: number; ids?: unknown };
      if (parsed.v === 1 && Array.isArray(parsed.ids)) {
        return parsed.ids.filter((x): x is string => typeof x === 'string' && x !== '');
      }
    } catch {
      // fall through: an unreadable index is treated as empty
    }
    return [];
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.kv.put(KV_KEYS.accountIndex, JSON.stringify({ v: 1, ids: [...new Set(ids)] }));
  }

  /**
   * Move a legacy record that names its account to that account's key.
   * The new record is written (and indexed) before the legacy key is deleted,
   * so a failure part-way leaves the token readable. An existing record for
   * the same account is newer and wins; the legacy copy is then dropped.
   */
  private async migrateLegacy(rec: StoredTokenRecord): Promise<string> {
    const id = accountIdFor(rec.email!);
    const existing = await this.kv.get(KV_KEYS.account(id));
    if (existing === null) {
      const refreshToken = await this.decrypt(rec, REFRESH_TOKEN_AAD);
      const moved: StoredTokenRecord = {
        ...rec,
        refresh_token: await encryptString(await this.key(), refreshToken, accountAad(id)),
      };
      await this.kv.put(KV_KEYS.account(id), JSON.stringify(moved));
    }
    await this.writeIndex([...(await this.readIndex()), id]);
    await this.kv.delete(KV_KEYS.refreshToken);
    return id;
  }

  /** Where the record for `id` lives, and the AAD it is encrypted with. */
  private location(id: string): { key: string; aad: string } {
    return id === LEGACY_ACCOUNT_ID
      ? { key: KV_KEYS.refreshToken, aad: REFRESH_TOKEN_AAD }
      : { key: KV_KEYS.account(id), aad: accountAad(id) };
  }

  /**
   * Ids of all stored accounts, legacy record first. A legacy record with an
   * email is migrated to its account key here (lazily, on first read).
   */
  async accountIds(): Promise<string[]> {
    const ids: string[] = [];
    let legacy: StoredTokenRecord | null = null;
    let legacyBroken = false;
    try {
      legacy = await this.readRecord(KV_KEYS.refreshToken);
    } catch {
      legacyBroken = true;
    }
    if (legacy?.email) {
      try {
        await this.migrateLegacy(legacy);
      } catch {
        // Leave it under the legacy key; it is still readable there.
        ids.push(LEGACY_ACCOUNT_ID);
      }
    } else if (legacy || legacyBroken) {
      ids.push(LEGACY_ACCOUNT_ID);
    }
    for (const id of await this.readIndex()) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /**
   * Every stored account with its metadata. Each refresh token is decrypted
   * (and discarded) so one that no longer decrypts shows up with an error.
   */
  async listAccounts(): Promise<StoredAccount[]> {
    const out: StoredAccount[] = [];
    for (const id of await this.accountIds()) {
      try {
        const loaded = await this.loadRefreshToken(id);
        // Indexed but deleted (e.g. removed by another isolate): skip.
        if (loaded) out.push({ id, meta: loaded.meta, error: null });
      } catch (e) {
        out.push({ id, meta: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  /** Metadata of one account (default: the first stored account). */
  async loadMeta(accountId?: string): Promise<StoredTokenMeta | null> {
    const id = accountId ?? (await this.accountIds())[0];
    if (id === undefined) return null;
    const rec = await this.readRecord(this.location(id).key);
    return rec ? toMeta(rec) : null;
  }

  /**
   * Decrypted refresh token plus metadata for one account (default: the
   * first stored account), or null when nothing is stored for it.
   */
  async loadRefreshToken(accountId?: string): Promise<{ refreshToken: string; meta: StoredTokenMeta } | null> {
    const id = accountId ?? (await this.accountIds())[0];
    if (id === undefined) return null;
    const { key, aad } = this.location(id);
    const rec = await this.readRecord(key);
    if (!rec) return null;
    return { refreshToken: await this.decrypt(rec, aad), meta: toMeta(rec) };
  }

  /**
   * Store a refresh token. With an email it goes to that account's key and
   * replaces only that account; a legacy record for the same email is
   * removed. Without an email it goes to the legacy key.
   */
  async save(
    refreshToken: string,
    meta: Omit<StoredTokenMeta, 'storedAt' | 'grantedScope'> & { grantedScope?: string | null },
  ): Promise<StoredTokenMeta> {
    const id = meta.email ? accountIdFor(meta.email) : LEGACY_ACCOUNT_ID;
    const { key, aad } = this.location(id);
    const rec: StoredTokenRecord = {
      v: 1,
      refresh_token: await encryptString(await this.key(), refreshToken, aad),
      scope: meta.scope,
      client_id: meta.clientId,
      ...(meta.email ? { email: meta.email } : {}),
      stored_at: new Date().toISOString(),
    };
    if (meta.grantedScope) rec.granted_scope = meta.grantedScope;
    await this.kv.put(key, JSON.stringify(rec));
    if (id !== LEGACY_ACCOUNT_ID) {
      await this.writeIndex([...(await this.readIndex()), id]);
      let legacy: StoredTokenRecord | null = null;
      try {
        legacy = await this.readRecord(KV_KEYS.refreshToken);
      } catch {
        legacy = null;
      }
      if (legacy?.email && accountIdFor(legacy.email) === id) await this.kv.delete(KV_KEYS.refreshToken);
    }
    return toMeta(rec);
  }

  /**
   * Record the scope Google returned on a later token response. No-op when
   * the account is not stored. Does not rotate the refresh token.
   */
  async updateGrantedScope(accountId: string, grantedScope: string): Promise<void> {
    const { key } = this.location(accountId);
    const rec = await this.readRecord(key);
    if (!rec || rec.granted_scope === grantedScope) return;
    const next: StoredTokenRecord = { ...rec, granted_scope: grantedScope };
    await this.kv.put(key, JSON.stringify(next));
  }

  /** Delete one account's record. Returns false when it was not stored. */
  async remove(accountId: string): Promise<boolean> {
    const { key } = this.location(accountId);
    const existed = (await this.kv.get(key)) !== null;
    await this.kv.delete(key);
    if (accountId !== LEGACY_ACCOUNT_ID) {
      const ids = await this.readIndex();
      if (ids.includes(accountId)) {
        await this.writeIndex(ids.filter((x) => x !== accountId));
        return true;
      }
    }
    return existed;
  }

  /** Delete every stored account. */
  async clear(): Promise<void> {
    for (const id of await this.readIndex()) await this.kv.delete(KV_KEYS.account(id));
    await this.kv.delete(KV_KEYS.accountIndex);
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
    grantedScope: rec.granted_scope && rec.granted_scope !== '' ? rec.granted_scope : null,
    clientId: rec.client_id,
    ...(rec.email ? { email: rec.email } : {}),
    storedAt: rec.stored_at,
  };
}
