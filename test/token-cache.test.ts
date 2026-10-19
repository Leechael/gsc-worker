/**
 * Access-token cache vs. the stored refresh token: changes made by another
 * isolate, reset() racing a refresh, KV read budget for /health, client
 * mismatch, and 401 recovery in the GSC client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TokenProvider, TokenRefreshError } from '../src/lib/auth.js';
import { GscApiError, GscClient } from '../src/lib/gsc-client.js';
import { GoogleTokenStore } from '../src/lib/google-oauth/store.js';
import { GOOGLE_SCOPE_READONLY } from '../src/lib/config.js';
import { MemoryKv } from './helpers/memory-kv.js';

const KEY = randomBytes(32).toString('base64');
const google = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'env-refresh', scopes: [GOOGLE_SCOPE_READONLY] };
const meta = { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid' };
const tick = () => new Promise((r) => setTimeout(r, 5));

function tokenEndpoint() {
  const refreshTokens: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const rt = new URLSearchParams(String(init?.body ?? '')).get('refresh_token')!;
    refreshTokens.push(rt);
    return Response.json({ access_token: `at-for-${rt}`, expires_in: 3600 });
  }) as typeof fetch;
  return { refreshTokens, fetchImpl };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Two stores over one KV namespace stand in for two isolates. */
function isolates() {
  const kv = new MemoryKv();
  return { kv, a: new GoogleTokenStore(kv, KEY), b: new GoogleTokenStore(kv, KEY) };
}

test('a token re-authorized in another isolate replaces the cached access token within 30s', async () => {
  const { a, b } = isolates();
  await a.save('first', meta);
  const c = clock();
  const { refreshTokens, fetchImpl } = tokenEndpoint();
  const provider = new TokenProvider(google, fetchImpl, { store: b, now: c.now });
  assert.equal(await provider.getAccessToken(), 'at-for-first');

  await tick();
  await a.save('second', meta);
  c.advance(10_000);
  assert.equal(await provider.getAccessToken(), 'at-for-first', 'metadata trusted for up to 30s');
  c.advance(25_000);
  assert.equal(await provider.getAccessToken(), 'at-for-second');
  assert.deepEqual(refreshTokens, ['first', 'second']);
});

test('a token disconnected in another isolate falls back to the env token within 30s', async () => {
  const { a, b } = isolates();
  await a.save('stored', meta);
  const c = clock();
  const { refreshTokens, fetchImpl } = tokenEndpoint();
  const provider = new TokenProvider(google, fetchImpl, { store: b, now: c.now });
  await provider.getAccessToken();
  await a.clear();
  c.advance(31_000);
  assert.equal(await provider.getAccessToken(), 'at-for-env-refresh');
  assert.deepEqual(refreshTokens, ['stored', 'env-refresh']);
});

test('a refresh in flight during reset() does not repopulate the cache', async () => {
  const { a } = isolates();
  await a.save('old', meta);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const refreshTokens: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const rt = new URLSearchParams(String(init?.body ?? '')).get('refresh_token')!;
    refreshTokens.push(rt);
    if (rt === 'old') await gate;
    return Response.json({ access_token: `at-for-${rt}`, expires_in: 3600 });
  }) as typeof fetch;
  const provider = new TokenProvider(google, fetchImpl, { store: a });
  const pending = provider.getAccessToken();
  await tick();
  await a.save('new', meta);
  provider.reset();
  release();
  assert.equal(await pending, 'at-for-old');
  assert.equal(await provider.getAccessToken(), 'at-for-new');
  assert.deepEqual(refreshTokens, ['old', 'new']);
});

test('status() reads KV at most once per 30s unless fresh is requested', async () => {
  const kv = new MemoryKv();
  let reads = 0;
  const realGet = kv.get.bind(kv);
  kv.get = async (key: string) => { reads++; return realGet(key); };
  const c = clock();
  const provider = new TokenProvider(google, tokenEndpoint().fetchImpl, { store: new GoogleTokenStore(kv, KEY), now: c.now });
  for (let i = 0; i < 5; i++) await provider.status();
  assert.equal(reads, 1);
  c.advance(30_000);
  await provider.status();
  assert.equal(reads, 2);
  await provider.status({ fresh: true });
  assert.equal(reads, 3);
});

test('a stored token issued to another OAuth client is refused with an actionable message', async () => {
  const { a } = isolates();
  await a.save('rt', { scope: GOOGLE_SCOPE_READONLY, clientId: 'old-client' });
  const { refreshTokens, fetchImpl } = tokenEndpoint();
  const provider = new TokenProvider(google, fetchImpl, { store: a });
  await assert.rejects(() => provider.getAccessToken(), (err: unknown) => {
    assert.ok(err instanceof TokenRefreshError);
    assert.match(err.message, /different OAuth client.*\/auth\/google/s);
    return true;
  });
  assert.equal(refreshTokens.length, 0);
});

test('GSC client: a 401 on a cached access token is retried once with a fresh token', async () => {
  let minted = 0;
  const tokenFetch = (async () => Response.json({ access_token: `at${++minted}`, expires_in: 3600 })) as typeof fetch;
  const provider = new TokenProvider(google, tokenFetch);
  const seen: string[] = [];
  const gscFetch = (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization!;
    seen.push(auth);
    return auth === 'Bearer at1'
      ? Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  const client = new GscClient({ tokenProvider: provider, fetchImpl: gscFetch });
  assert.deepEqual(await client.request('/webmasters/v3/sites'), { ok: true });
  assert.deepEqual(seen, ['Bearer at1', 'Bearer at2']);
});

test('GSC client: a second 401 is reported, not retried forever', async () => {
  let minted = 0;
  const provider = new TokenProvider(google, (async () => Response.json({ access_token: `at${++minted}` })) as typeof fetch);
  let calls = 0;
  const gscFetch = (async () => {
    calls++;
    return Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 });
  }) as typeof fetch;
  const client = new GscClient({ tokenProvider: provider, fetchImpl: gscFetch });
  await assert.rejects(() => client.request('/webmasters/v3/sites'), (err: unknown) => err instanceof GscApiError && err.status === 401);
  assert.equal(calls, 2);
});
