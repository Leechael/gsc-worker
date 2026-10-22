/** Encryption, PKCE, KV store and token-source precedence for the in-Worker Google flow. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  decryptString,
  encryptString,
  importEncryptionKey,
  parseEncryptionKey,
  pkceChallenge,
  randomToken,
} from '../src/lib/google-oauth/crypto.js';
import { GoogleTokenStore, KV_KEYS, OAUTH_STATE_TTL_SEC, StoredTokenUnreadableError } from '../src/lib/google-oauth/store.js';
import { emailFromIdToken, scopesCover } from '../src/lib/google-oauth/google.js';
import { TokenProvider, TokenRefreshError } from '../src/lib/auth.js';
import { GOOGLE_SCOPE_FULL, GOOGLE_SCOPE_READONLY, parseConfig, setEnvSource, validateHttpConfig, validateHttpWarnings } from '../src/lib/config.js';
import { MemoryKv } from './helpers/memory-kv.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

// ---------- encryption ----------

test('AES-GCM round-trip; ciphertext differs per call and hides the plaintext', async () => {
  const key = await importEncryptionKey(KEY);
  const a = await encryptString(key, '1//refresh-secret', 'aad');
  const b = await encryptString(key, '1//refresh-secret', 'aad');
  assert.notEqual(a, b);
  assert.ok(!a.includes('refresh-secret'));
  assert.match(a, /^v1\.[\w-]+\.[\w-]+$/);
  assert.equal(await decryptString(key, a, 'aad'), '1//refresh-secret');
});

test('decrypt fails with the wrong key, wrong AAD, or tampered ciphertext', async () => {
  const key = await importEncryptionKey(KEY);
  const blob = await encryptString(key, 'secret', 'aad');
  await assert.rejects(() => importEncryptionKey(OTHER_KEY).then((k) => decryptString(k, blob, 'aad')));
  await assert.rejects(() => decryptString(key, blob, 'other-aad'));
  const [v, iv, ct] = blob.split('.') as [string, string, string];
  const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
  await assert.rejects(() => decryptString(key, `${v}.${iv}.${flipped}`, 'aad'));
  await assert.rejects(() => decryptString(key, 'v2.x.y', 'aad'), /unrecognized/);
});

test('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or base64url)', () => {
  assert.equal(parseEncryptionKey(KEY).ok, true);
  assert.equal(parseEncryptionKey(randomBytes(32).toString('base64url')).ok, true);
  const short = parseEncryptionKey(randomBytes(16).toString('base64'));
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /16 bytes/);
  assert.equal(parseEncryptionKey('not base64 at all!').ok, false);
});

// ---------- PKCE / state ----------

test('PKCE S256 challenge matches SHA-256(verifier) base64url', async () => {
  const verifier = randomToken();
  assert.match(verifier, /^[\w-]{43}$/);
  assert.equal(await pkceChallenge(verifier), createHash('sha256').update(verifier).digest('base64url'));
});

test('state is single use, encrypted at rest and stored with a TTL', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  const state = randomToken();
  const record = { codeVerifier: 'verifier-123', principal: 'ada@example.com', redirectUri: 'https://h/auth/google/callback', createdAt: new Date().toISOString() };
  await store.putState(state, record);
  const raw = kv.data.get(KV_KEYS.oauthState(state))!;
  assert.ok(!raw.includes('verifier-123'));
  assert.equal(kv.ttls.get(KV_KEYS.oauthState(state)), OAUTH_STATE_TTL_SEC);
  assert.deepEqual(await store.takeState(state, 'ada@example.com'), { status: 'ok', record });
  assert.deepEqual(await store.takeState(state, 'ada@example.com'), { status: 'missing' }, 'second use must fail');
  assert.deepEqual(await store.takeState('unknown', 'ada@example.com'), { status: 'missing' });
});

test('expired state is rejected even if KV has not evicted it yet', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  const createdAt = new Date(Date.now() - (OAUTH_STATE_TTL_SEC + 5) * 1000).toISOString();
  await store.putState('s1', { codeVerifier: 'v', principal: 'p', redirectUri: 'r', createdAt });
  assert.deepEqual(await store.takeState('s1', 'p'), { status: 'missing' });
});

test('state presented by another identity is refused and left for its owner', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.putState('s1', { codeVerifier: 'v', principal: 'owner', redirectUri: 'r', createdAt: new Date().toISOString() });
  assert.deepEqual(await store.takeState('s1', 'intruder'), { status: 'mismatch' });
  assert.ok(kv.data.has(KV_KEYS.oauthState('s1')));
  assert.equal((await store.takeState('s1', 'owner')).status, 'ok');
});

test('a state blob cannot be replayed under a different state key', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.putState('s1', { codeVerifier: 'v', principal: 'p', redirectUri: 'r', createdAt: new Date().toISOString() });
  kv.data.set(KV_KEYS.oauthState('s2'), kv.data.get(KV_KEYS.oauthState('s1'))!);
  assert.deepEqual(await store.takeState('s2', 'p'), { status: 'missing' });
});

// ---------- token store ----------

test('stored refresh token is encrypted in KV and round-trips with metadata', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('1//stored-refresh', { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid', email: 'ada@example.com' });
  const raw = kv.data.get(KV_KEYS.account('ada@example.com'))!;
  assert.ok(!raw.includes('stored-refresh'));
  const loaded = await store.loadRefreshToken();
  assert.equal(loaded?.refreshToken, '1//stored-refresh');
  assert.equal(loaded?.meta.email, 'ada@example.com');
  assert.equal(loaded?.meta.grantedScope, null, 'legacy save without grantedScope is unknown');
  assert.equal((await store.loadMeta())?.clientId, 'cid');
  await store.clear();
  assert.equal(await store.loadRefreshToken(), null);
});

test('a token stored under another key is reported unreadable', async () => {
  const kv = new MemoryKv();
  await new GoogleTokenStore(kv, KEY).save('rt', { scope: 's', clientId: 'c' });
  await assert.rejects(() => new GoogleTokenStore(kv, OTHER_KEY).loadRefreshToken(), /TOKEN_ENCRYPTION_KEY.*\/auth\/google/s);
});

// ---------- precedence ----------

function tokenEndpoint(response: { status?: number; body: unknown }) {
  const posted: URLSearchParams[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    posted.push(new URLSearchParams(String(init?.body ?? '')));
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { posted, fetchImpl };
}

const google = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'env-refresh', scopes: [GOOGLE_SCOPE_READONLY] };

test('a stored record with the wrong shape is reported unreadable, not a TypeError', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt', { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid' });
  const good = JSON.parse(kv.data.get(KV_KEYS.refreshToken)!) as Record<string, unknown>;
  for (const bad of ['null', '"text"', JSON.stringify({ ...good, scope: undefined }), JSON.stringify({ ...good, stored_at: 5 }), JSON.stringify({ ...good, email: 7 })]) {
    kv.data.set(KV_KEYS.refreshToken, bad);
    await assert.rejects(() => store.loadMeta(), StoredTokenUnreadableError, bad);
  }
});

test('precedence: KV-stored token wins over GOOGLE_REFRESH_TOKEN', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  await store.save('kv-refresh', { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid' });
  const { posted, fetchImpl } = tokenEndpoint({ body: { access_token: 'at', expires_in: 3600 } });
  const provider = new TokenProvider(google, fetchImpl, { store });
  assert.equal(await provider.getAccessToken(), 'at');
  assert.equal(posted[0]?.get('refresh_token'), 'kv-refresh');
  const status = await provider.status();
  assert.equal(status.source, 'kv');
  assert.equal(status.configured, true);
});

test('precedence: env token is used when KV holds nothing', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  const { posted, fetchImpl } = tokenEndpoint({ body: { access_token: 'at' } });
  const provider = new TokenProvider(google, fetchImpl, { store });
  await provider.getAccessToken();
  assert.equal(posted[0]?.get('refresh_token'), 'env-refresh');
  assert.equal((await provider.status()).source, 'env');
});

test('precedence: no KV and no env token → source none, credentials-missing error', async () => {
  const { fetchImpl } = tokenEndpoint({ body: {} });
  const provider = new TokenProvider({ clientId: 'cid', clientSecret: 'sec', scopes: [] }, fetchImpl);
  assert.equal((await provider.status()).source, 'none');
  await assert.rejects(() => provider.getAccessToken(), /\/auth\/google/);
});

test('unreadable KV token fails closed instead of falling back to env', async () => {
  const kv = new MemoryKv();
  await new GoogleTokenStore(kv, OTHER_KEY).save('kv-refresh', { scope: 's', clientId: 'cid' });
  const { posted, fetchImpl } = tokenEndpoint({ body: { access_token: 'at' } });
  const provider = new TokenProvider(google, fetchImpl, { store: new GoogleTokenStore(kv, KEY) });
  await assert.rejects(() => provider.getAccessToken(), TokenRefreshError);
  assert.equal(posted.length, 0);
  const status = await provider.status();
  assert.equal(status.source, 'kv');
  assert.match(status.error ?? '', /cannot be decrypted/);
});

test('invalid_grant on the KV token tells the user to re-open /auth/google', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  await store.save('kv-refresh', { scope: 's', clientId: 'cid' });
  const { fetchImpl } = tokenEndpoint({ status: 400, body: { error: 'invalid_grant' } });
  const provider = new TokenProvider(google, fetchImpl, { store });
  await assert.rejects(
    () => provider.getAccessToken(),
    (err: unknown) => {
      assert.ok(err instanceof TokenRefreshError && err.invalidGrant);
      assert.match(err.message, /open https:\/\/<this-worker-host>\/auth\/google/);
      assert.doesNotMatch(err.message, /npm run auth/);
      return true;
    },
  );
});

test('invalid_grant on the env token mentions both /auth/google and npm run auth', async () => {
  const { fetchImpl } = tokenEndpoint({ status: 400, body: { error: 'invalid_grant' } });
  const provider = new TokenProvider(google, fetchImpl);
  await assert.rejects(() => provider.getAccessToken(), (err: unknown) => {
    assert.ok(err instanceof TokenRefreshError);
    assert.match(err.message, /\/auth\/google/);
    assert.match(err.message, /npm run auth/);
    return true;
  });
});

test('reset() drops the cached access token so a newly stored token is used', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  await store.save('first', { scope: 's', clientId: 'cid' });
  const { posted, fetchImpl } = tokenEndpoint({ body: { access_token: 'at', expires_in: 3600 } });
  const provider = new TokenProvider(google, fetchImpl, { store });
  await provider.getAccessToken();
  await store.save('second', { scope: 's', clientId: 'cid' });
  await provider.getAccessToken();
  assert.equal(posted.length, 1, 'cached access token reused');
  provider.reset();
  await provider.getAccessToken();
  assert.equal(posted[1]?.get('refresh_token'), 'second');
});

// ---------- helpers ----------

test('scopesCover: full covers readonly, readonly does not cover full', () => {
  assert.equal(scopesCover(`openid ${GOOGLE_SCOPE_FULL}`, [GOOGLE_SCOPE_READONLY]), true);
  assert.equal(scopesCover(GOOGLE_SCOPE_READONLY, [GOOGLE_SCOPE_FULL]), false);
  assert.equal(scopesCover('openid email', [GOOGLE_SCOPE_READONLY]), false);
});

test('updateGrantedScope writes the Google-returned scope without rotating the token', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  await store.save('rt', { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid', email: 'ada@example.com' });
  await store.updateGrantedScope('ada@example.com', GOOGLE_SCOPE_FULL);
  const loaded = await store.loadRefreshToken('ada@example.com');
  assert.equal(loaded?.refreshToken, 'rt');
  assert.equal(loaded?.meta.grantedScope, GOOGLE_SCOPE_FULL);
  assert.equal(loaded?.meta.scope, GOOGLE_SCOPE_READONLY);
});

test('emailFromIdToken reads the email claim and tolerates junk', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'ada@example.com' })).toString('base64url');
  assert.equal(emailFromIdToken(`h.${payload}.sig`), 'ada@example.com');
  assert.equal(emailFromIdToken('garbage'), null);
});

// ---------- config validation ----------

function workerConfig(env: Record<string, unknown>) {
  setEnvSource({ MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: 'x'.repeat(40), MCP_ALLOWED_HOSTS: 'gsc.example.com', ...env });
  const cfg = parseConfig();
  setEnvSource(process.env as Record<string, unknown>);
  return cfg;
}

test('config: KV bound without TOKEN_ENCRYPTION_KEY fails closed on Workers', () => {
  const errors = validateHttpConfig(workerConfig({ GSC_TOKENS: new MemoryKv() }), 'worker');
  assert.ok(errors.some((e) => /GSC_TOKENS is bound but TOKEN_ENCRYPTION_KEY is not set/.test(e)), errors.join('\n'));
});

test('config: malformed TOKEN_ENCRYPTION_KEY with KV bound is an error', () => {
  const errors = validateHttpConfig(workerConfig({ GSC_TOKENS: new MemoryKv(), TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' }), 'worker');
  assert.ok(errors.some((e) => /TOKEN_ENCRYPTION_KEY decodes to 5 bytes/.test(e)), errors.join('\n'));
});

test('config: valid KV + key passes; key without KV only warns', () => {
  assert.deepEqual(validateHttpConfig(workerConfig({ GSC_TOKENS: new MemoryKv(), TOKEN_ENCRYPTION_KEY: KEY }), 'worker'), []);
  const keyOnly = workerConfig({ TOKEN_ENCRYPTION_KEY: KEY });
  assert.deepEqual(validateHttpConfig(keyOnly, 'worker'), []);
  assert.ok(validateHttpWarnings(keyOnly).some((w) => /no GSC_TOKENS KV namespace is bound/.test(w)));
});

test('config: GOOGLE_REDIRECT_URI must be https, hit the callback path and be an allowed host', () => {
  const check = (uri: string) => validateHttpConfig(workerConfig({ GOOGLE_REDIRECT_URI: uri }), 'worker');
  assert.deepEqual(check('https://gsc.example.com/auth/google/callback'), []);
  assert.deepEqual(check('http://localhost:8787/auth/google/callback'), []);
  assert.ok(check('http://gsc.example.com/auth/google/callback').some((e) => /must use https/.test(e)));
  assert.ok(check('https://gsc.example.com/oauth/cb').some((e) => /must point at/.test(e)));
  assert.ok(check('https://other.example.com/auth/google/callback').some((e) => /not in MCP_ALLOWED_HOSTS/.test(e)));
  assert.ok(check('not a url').some((e) => /not an absolute URL/.test(e)));
});

test('config: a non-KV GSC_TOKENS value is ignored', () => {
  const cfg = workerConfig({ GSC_TOKENS: 'just-a-string' });
  assert.equal(cfg.googleAuth.kv, undefined);
});

test('MemoryKv: a write without expirationTtl clears the previous TTL, like Workers KV', async () => {
  const kv = new MemoryKv();
  await kv.put('k', 'a', { expirationTtl: 600 });
  await kv.put('k', 'b');
  assert.equal(kv.ttls.has('k'), false);
});
