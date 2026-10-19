/**
 * Who may use /auth/google: real Cloudflare Access JWTs through the Worker
 * app (JWKS served by a stubbed fetch), service-token restriction,
 * GOOGLE_AUTH_ADMINS, and state binding across combined auth modes.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { buildApp } from '../src/app.js';
import { GOOGLE_SCOPE_READONLY, setEnvSource } from '../src/lib/config.js';
import { GoogleTokenStore, KV_KEYS } from '../src/lib/google-oauth/store.js';
import { MemoryKv } from './helpers/memory-kv.js';

const HOST = 'gsc.example.com';
const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag';
const BEARER = 'c'.repeat(48);
const KEY = randomBytes(32).toString('base64');
const realFetch = globalThis.fetch;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'k1';
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnvSource(process.env as Record<string, unknown>);
});

function accessJwt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setSubject(claims.email ? 'sub-1' : '')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
const user = (email: string) => accessJwt({ email });
const service = (cn: string) => accessJwt({ common_name: cn });

function setup(env: Record<string, unknown> = {}) {
  const kv = new MemoryKv();
  const googleCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
    googleCalls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ refresh_token: '1//r', scope: GOOGLE_SCOPE_READONLY });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  setEnvSource({
    MCP_AUTH_MODE: 'cf-access',
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    MCP_ALLOWED_HOSTS: HOST,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'sec',
    GSC_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
    ...env,
  });
  const app = buildApp('worker');
  const call = (path: string, jwt: string | null, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(`https://${HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: { host: HOST, ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...init.headers },
    });
  return { kv, call, googleCalls, store: new GoogleTokenStore(kv, KEY) };
}

async function start(call: ReturnType<typeof setup>['call'], jwt: string, headers: Record<string, string> = {}) {
  const res = await call('/auth/google', jwt, { headers });
  assert.equal(res.status, 302, await res.clone().text());
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

test('Access user: full start → callback flow binds state to the email', async () => {
  const { call, kv, store } = setup();
  const ada = await user('ada@example.com');
  const state = await start(call, ada);
  const pending = await new GoogleTokenStore(kv, KEY).takeState(state, 'cf-access:ada@example.com');
  assert.equal(pending.status, 'ok');
  // put it back for the real callback
  if (pending.status === 'ok') await store.putState(state, pending.record);
  const res = await call(`/auth/google/callback?code=c&state=${state}`, ada);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
});

test('the Access email is matched case-insensitively between start and callback', async () => {
  const { call, kv } = setup();
  const state = await start(call, await user('Ada@Example.com'));
  const res = await call(`/auth/google/callback?code=c&state=${state}`, await user('ada@example.com'));
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
});

test('Access user B cannot complete a flow started by user A, and does not consume it', async () => {
  const { call, kv, googleCalls } = setup();
  const state = await start(call, await user('ada@example.com'));
  const res = await call(`/auth/google/callback?code=c&state=${state}`, await user('mallory@example.com'));
  assert.equal(res.status, 403);
  assert.equal(googleCalls.length, 0);
  assert.ok(kv.data.has(KV_KEYS.oauthState(state)), 'state stays usable for its owner');
  const ok = await call(`/auth/google/callback?code=c&state=${state}`, await user('ada@example.com'));
  assert.equal(ok.status, 200);
});

test('Access service tokens may read status but not connect or disconnect', async () => {
  const { call, store, kv, googleCalls } = setup();
  const bot = await service('ci-bot');
  assert.equal((await call('/auth/google/status', bot)).status, 200);
  const startRes = await call('/auth/google', bot);
  assert.equal(startRes.status, 403);
  assert.match(await startRes.text(), /service tokens/);

  await store.putState('s1', { codeVerifier: 'v'.repeat(43), principal: 'cf-access:ci-bot', redirectUri: `https://${HOST}/auth/google/callback`, createdAt: new Date().toISOString() });
  assert.equal((await call('/auth/google/callback?code=c&state=s1', bot)).status, 403);

  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'cid' });
  assert.equal((await call('/auth/google/revoke', bot, { method: 'POST' })).status, 403);
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
  assert.equal(googleCalls.length, 0);
});

test('GOOGLE_AUTH_ADMINS restricts connect/disconnect to the listed identities', async () => {
  const { call } = setup({ GOOGLE_AUTH_ADMINS: 'Ada@Example.com, ci-bot' });
  assert.equal((await call('/auth/google', await user('mallory@example.com'))).status, 403);
  assert.equal((await call('/auth/google/status', await user('mallory@example.com'))).status, 200);
  await start(call, await user('ada@example.com'));
  await start(call, await service('ci-bot'));
});

test('cf-access,bearer: state binds to the Access identity, not the shared bearer', async () => {
  const { call, googleCalls } = setup({ MCP_AUTH_MODE: 'cf-access,bearer', MCP_AUTH_TOKEN: BEARER });
  const bearer = { authorization: `Bearer ${BEARER}` };
  const state = await start(call, await user('ada@example.com'), bearer);
  const res = await call(`/auth/google/callback?code=c&state=${state}`, await user('mallory@example.com'), { headers: bearer });
  assert.equal(res.status, 403);
  assert.equal(googleCalls.length, 0);
});

test('a missing Access JWT is rejected even with the bearer token in combined mode', async () => {
  const { call } = setup({ MCP_AUTH_MODE: 'cf-access,bearer', MCP_AUTH_TOKEN: BEARER });
  const res = await call('/auth/google', null, { headers: { authorization: `Bearer ${BEARER}` } });
  assert.equal(res.status, 401);
});
