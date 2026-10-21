/**
 * /auth/google/* routes through the real Worker app: auth protection, state +
 * PKCE validation, encrypted storage, status, revoke, and the Node fallback.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { GOOGLE_SCOPE_FULL, GOOGLE_SCOPE_READONLY, setEnvSource } from '../src/lib/config.js';
import { GoogleTokenStore, KV_KEYS } from '../src/lib/google-oauth/store.js';
import { MemoryKv } from './helpers/memory-kv.js';

const HOST = 'gsc.example.com';
const TOKEN = 'b'.repeat(48);
const KEY = randomBytes(32).toString('base64');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnvSource(process.env as Record<string, unknown>);
});

function setup(env: Record<string, unknown> = {}, entry: 'worker' | 'node' = 'worker') {
  const kv = new MemoryKv();
  setEnvSource({
    MCP_AUTH_MODE: 'bearer',
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: HOST,
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GSC_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
    ...env,
  });
  const app = buildApp(entry);
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; auth?: boolean } = {}) =>
    app.request(`https://${HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        host: HOST,
        ...(init.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
        ...init.headers,
      },
    });
  return { kv, app, call, store: new GoogleTokenStore(kv, KEY) };
}

interface GoogleCall { url: string; body: URLSearchParams }

function mockGoogle(handlers: { token?: () => Response; revoke?: () => Response; refresh?: () => Response }) {
  const calls: GoogleCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, body });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (body.get('grant_type') === 'refresh_token') {
        return handlers.refresh?.() ?? Response.json({ access_token: 'at', expires_in: 3600 });
      }
      return handlers.token?.() ?? Response.json({ error: 'unexpected' }, { status: 500 });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return handlers.revoke?.() ?? new Response('{}');
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function idToken(email: string): string {
  return `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
}

async function startFlow(call: ReturnType<typeof setup>['call']) {
  const res = await call('/auth/google');
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  return { res, location, state: location.searchParams.get('state')! };
}

// ---------- protection ----------

test('every /auth route rejects unauthenticated requests on Workers', async () => {
  const { call } = setup();
  for (const [method, path] of [
    ['GET', '/auth/google'],
    ['GET', '/auth/google/callback?code=c&state=s'],
    ['GET', '/auth/google/status'],
    ['POST', '/auth/google/revoke'],
    ['GET', '/auth/google/unknown'],
  ] as const) {
    const res = await call(path, { method, auth: false });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const wrong = await call('/auth/google/status', { headers: { authorization: `Bearer ${'x'.repeat(48)}` } });
  assert.equal(wrong.status, 401);
});

test('cf-access mode: /auth requires the Access JWT header', async () => {
  const { call } = setup({
    MCP_AUTH_MODE: 'cf-access',
    CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'aud',
  });
  const res = await call('/auth/google', { auth: false });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Cf-Access-Jwt-Assertion/);
});

test('host allowlist applies to /auth routes', async () => {
  const { app } = setup();
  const res = await app.request('https://evil.example.net/auth/google/status', {
    headers: { host: 'evil.example.net', authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 403);
});

test('KV bound without TOKEN_ENCRYPTION_KEY: /auth answers 503 and /health reports invalid config', async () => {
  const { call } = setup({ TOKEN_ENCRYPTION_KEY: undefined });
  assert.equal((await call('/auth/google')).status, 503);
  const health = await (await call('/health', { auth: false })).json() as Record<string, unknown>;
  assert.equal(health.ok, false);
});

test('Node entry: /auth routes are disabled with a pointer to npm run auth', async () => {
  const { call } = setup({ GSC_TOKENS: undefined, TOKEN_ENCRYPTION_KEY: undefined }, 'node');
  const res = await call('/auth/google');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /npm run auth/);
});

// ---------- start ----------

test('start redirects to Google with offline access, consent, scope, state and S256 PKCE', async () => {
  const { call, store, kv } = setup();
  const { res, location, state } = await startFlow(call);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = location.searchParams;
  assert.equal(p.get('client_id'), 'client-id.apps.googleusercontent.com');
  assert.equal(p.get('redirect_uri'), `https://${HOST}/auth/google/callback`);
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent select_account');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.deepEqual(p.get('scope')!.split(' '), [GOOGLE_SCOPE_READONLY, 'openid', 'email']);
  assert.ok(kv.data.has(KV_KEYS.oauthState(state)));
  const taken = await store.takeState(state, 'bearer:static-bearer');
  assert.equal(taken.status, 'ok', 'state is bound to the bearer identity');
  if (taken.status === 'ok') {
    assert.equal(p.get('code_challenge'), createHash('sha256').update(taken.record.codeVerifier).digest('base64url'));
  }
});

test('start requests the full webmasters scope only when GSC_SCOPES=full', async () => {
  const { call } = setup({ GSC_SCOPES: 'full' });
  const { location } = await startFlow(call);
  assert.ok(location.searchParams.get('scope')!.split(' ').includes(GOOGLE_SCOPE_FULL));
  assert.ok(!location.searchParams.get('scope')!.split(' ').includes(GOOGLE_SCOPE_READONLY));
});

const AUTH_HOST = 'auth.example.org';
const PINNED_REDIRECT = `https://${AUTH_HOST}/auth/google/callback`;

test('GOOGLE_REDIRECT_URI overrides the host-derived redirect', async () => {
  const { call } = setup({ MCP_ALLOWED_HOSTS: `${HOST},${AUTH_HOST}`, GOOGLE_REDIRECT_URI: PINNED_REDIRECT });
  const { location } = await startFlow(call);
  assert.equal(location.searchParams.get('redirect_uri'), PINNED_REDIRECT);
});

test('with a pinned GOOGLE_REDIRECT_URI, the callback is only accepted on that host', async () => {
  const { app, call, kv } = setup({ MCP_ALLOWED_HOSTS: `${HOST},${AUTH_HOST}`, GOOGLE_REDIRECT_URI: PINNED_REDIRECT });
  const { state } = await startFlow(call);
  const calls = mockGoogle({ token: () => Response.json({ refresh_token: 'r', scope: GOOGLE_SCOPE_READONLY }) });
  const wrongHost = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(wrongHost.status, 400);
  assert.match(await wrongHost.text(), /invalid_redirect_uri/);
  assert.equal(calls.length, 0, 'code must not be exchanged on the wrong host');
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
  const res = await app.request(`https://${AUTH_HOST}/auth/google/callback?code=c&state=${state}`, {
    headers: { host: AUTH_HOST, authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, 'the refused attempt must not consume the state');
});

test('start without a Google client answers 503', async () => {
  const { call } = setup({ GOOGLE_CLIENT_SECRET: undefined });
  const res = await call('/auth/google');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Web application/);
});

// ---------- callback ----------

test('callback exchanges the code with the PKCE verifier and stores the token encrypted', async () => {
  const { call, kv } = setup({ GOOGLE_REFRESH_TOKEN: 'env-refresh' });
  const { state } = await startFlow(call);
  const calls = mockGoogle({
    token: () => Response.json({ refresh_token: '1//new-refresh', access_token: 'at', scope: `${GOOGLE_SCOPE_READONLY} openid`, id_token: idToken('ada@example.com') }),
  });
  const res = await call(`/auth/google/callback?code=auth-code&state=${state}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 303, await res.clone().text());
  assert.equal(res.headers.get('location'), '/auth/google/status?connected=1');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const page = await call('/auth/google/status?connected=1', { headers: { accept: 'text/html' } });
  const html = await page.text();
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html, /ada@example\.com/);
  assert.match(html, /Disconnect/);
  assert.ok(!html.includes('new-refresh'), 'token must never be shown');

  const exchange = calls[0]!;
  assert.equal(exchange.body.get('grant_type'), 'authorization_code');
  assert.equal(exchange.body.get('code'), 'auth-code');
  assert.equal(exchange.body.get('redirect_uri'), `https://${HOST}/auth/google/callback`);
  assert.match(exchange.body.get('code_verifier') ?? '', /^[\w-]{43}$/);

  // Stored under the account's own key, since Google returned its email.
  const raw = kv.data.get(KV_KEYS.account('ada@example.com'))!;
  assert.ok(raw && !raw.includes('new-refresh'));
  assert.equal(kv.data.has(KV_KEYS.oauthState(state)), false, 'state consumed');

  // KV token now takes precedence over the env token.
  const status = await (await call('/auth/google/status')).json() as Record<string, any>;
  assert.equal(status.active_source, 'kv');
  assert.equal(status.stored.email, 'ada@example.com');
  assert.equal(status.stored.covers_required_scope, true);
  assert.equal(status.env_refresh_token_configured, true);
  assert.ok(!JSON.stringify(status).includes('new-refresh'), 'status must not leak the token');

  const health = await (await call('/health', { auth: false })).json() as Record<string, unknown>;
  assert.equal(health.google_token_source, 'kv');
  assert.equal(health.google_token_configured, true);
});

test('callback rejects unknown, reused, and missing state', async () => {
  const { call } = setup();
  mockGoogle({ token: () => Response.json({ refresh_token: 'r', scope: GOOGLE_SCOPE_READONLY }) });
  assert.equal((await call('/auth/google/callback?code=c&state=forged')).status, 400);
  assert.equal((await call('/auth/google/callback?code=c')).status, 400);
  const { state } = await startFlow(call);
  assert.equal((await call(`/auth/google/callback?code=c&state=${state}`)).status, 200);
  const replay = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /already used/);
});

test('callback from a different identity than the one that started the flow → 403', async () => {
  const { call, store } = setup();
  await store.putState('s-other', {
    codeVerifier: 'v'.repeat(43),
    principal: 'someone-else@example.com',
    redirectUri: `https://${HOST}/auth/google/callback`,
    createdAt: new Date().toISOString(),
  });
  const calls = mockGoogle({});
  const res = await call('/auth/google/callback?code=c&state=s-other');
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, 'code must not be exchanged');
});

test('callback with a Google error consumes the state and stores nothing', async () => {
  const { call, kv } = setup();
  const { state } = await startFlow(call);
  const res = await call(`/auth/google/callback?error=access_denied&state=${state}`);
  assert.equal(res.status, 400);
  assert.equal(kv.data.has(KV_KEYS.oauthState(state)), false);
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
});

test('callback accepts a token response that omits scope (RFC 6749: same as requested)', async () => {
  const { call, store } = setup();
  const { state } = await startFlow(call);
  mockGoogle({ token: () => Response.json({ refresh_token: 'r', access_token: 'at' }) });
  const res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await store.loadMeta())?.scope, GOOGLE_SCOPE_READONLY);
});

test('callback answers 503 with a retry hint when KV cannot store the token', async () => {
  const { call, kv } = setup();
  const { state } = await startFlow(call);
  const realPut = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    if (key === KV_KEYS.refreshToken) throw new Error('KV PUT failed: 429 Too Many Requests');
    return realPut(key, value, options);
  };
  const calls = mockGoogle({ token: () => Response.json({ refresh_token: 'r', scope: GOOGLE_SCOPE_READONLY }) });
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  let res: Response;
  try {
    res = await call(`/auth/google/callback?code=c&state=${state}`);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.status, 503);
  const body = await res.json() as Record<string, string>;
  assert.equal(body.error, 'storage_failed');
  assert.match(body.error_description!, /\/auth\/google/);
  assert.ok(logged.some((l) => l.includes('429')), 'cause is logged');
  assert.ok(!calls.some((c) => c.url.endsWith('/revoke')), 'the grant is not revoked');
});

test('callback refuses a grant without the Search Console scope', async () => {
  const { call, kv } = setup();
  const { state } = await startFlow(call);
  mockGoogle({ token: () => Response.json({ refresh_token: 'r', scope: 'openid email' }) });
  const res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /insufficient_scope/);
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
});

test('callback surfaces token-exchange failures and a missing refresh token as 502', async () => {
  const { call } = setup();
  let { state } = await startFlow(call);
  mockGoogle({ token: () => Response.json({ error: 'invalid_grant', error_description: 'Bad code' }, { status: 400 }) });
  let res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /invalid_grant/);

  ({ state } = await startFlow(call));
  mockGoogle({ token: () => Response.json({ access_token: 'at', scope: GOOGLE_SCOPE_READONLY }) });
  res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /no_refresh_token/);
});

test('the Google error parameter is only echoed when it is a plain error code', async () => {
  const { call } = setup();
  let { state } = await startFlow(call);
  let res = await call(`/auth/google/callback?error=${encodeURIComponent('<script>x</script> call +1-555')}&state=${state}`, { headers: { accept: 'text/html' } });
  let html = await res.text();
  assert.ok(!html.includes('&lt;script') && !html.includes('<script') && !html.includes('555'));
  assert.match(html, /unknown_error/);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  ({ state } = await startFlow(call));
  res = await call(`/auth/google/callback?error=access_denied&state=${state}`);
  assert.match(await res.text(), /'access_denied'/);
});

test('HTML pages escape stored values (account email from the ID token)', async () => {
  const { call, store } = setup();
  await store.save('1//r', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c', email: '<img src=x onerror=alert(1)>@x' });
  const html = await (await call('/auth/google/status', { headers: { accept: 'text/html' } })).text();
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;@x/);
});

test('Disconnect is offered only on the status page, and only when a token is stored', async () => {
  const { call, store } = setup();
  const html = (path: string) => call(path, { headers: { accept: 'text/html' } }).then((r) => r.text());
  assert.doesNotMatch(await html('/auth/google/status'), /Disconnect/);
  await store.save('1//r', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  assert.match(await html('/auth/google/status'), /Disconnect/);
  assert.doesNotMatch(await html('/auth/google/callback?code=c&state=nope'), /Disconnect/);
});

// ---------- status ----------

test('status without KV storage reports the env source', async () => {
  const { call } = setup({ GSC_TOKENS: undefined, TOKEN_ENCRYPTION_KEY: undefined, GOOGLE_REFRESH_TOKEN: 'env' });
  const status = await (await call('/auth/google/status')).json() as Record<string, any>;
  assert.equal(status.active_source, 'env');
  assert.equal(status.storage.kv_bound, false);
  assert.equal(status.stored, null);
  assert.equal((await call('/auth/google')).status, 503);
});

// ---------- revoke ----------

test('revoke calls Google with the stored token, deletes it and falls back to env', async () => {
  const { call, store, kv } = setup({ GOOGLE_REFRESH_TOKEN: 'env-refresh' });
  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'client-id.apps.googleusercontent.com' });
  const calls = mockGoogle({ revoke: () => new Response('{}', { status: 200 }) });
  const res = await call('/auth/google/revoke', { method: 'POST' });
  const body = await res.json() as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.deepEqual({ deleted: body.deleted, revoked: body.revoked, active_source: body.active_source }, { deleted: true, revoked: true, active_source: 'env' });
  assert.equal(calls[0]?.url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(calls[0]?.body.get('token'), '1//stored');
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
});

test('revoke deletes locally before calling Google; a KV failure revokes nothing', async () => {
  const { call, store, kv } = setup();
  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  const order: string[] = [];
  const realDelete = kv.delete.bind(kv);
  kv.delete = async (key: string) => { order.push(`kv.delete ${key}`); return realDelete(key); };
  globalThis.fetch = (async (input: string | URL | Request) => { order.push(`fetch ${String(input)}`); return new Response('{}'); }) as typeof fetch;
  assert.equal((await call('/auth/google/revoke', { method: 'POST' })).status, 200);
  assert.deepEqual(order, [`kv.delete ${KV_KEYS.refreshToken}`, 'fetch https://oauth2.googleapis.com/revoke']);

  await store.save('1//again', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  order.length = 0;
  kv.delete = async () => { throw new Error('KV unavailable'); };
  const res = await call('/auth/google/revoke', { method: 'POST' });
  assert.equal(res.status, 500);
  assert.equal(order.length, 0, 'Google must not be called when the local delete failed');
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
});

test('revoke still deletes locally when Google cannot be reached, with a warning', async () => {
  const { call, store, kv } = setup();
  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const body = await (await call('/auth/google/revoke', { method: 'POST' })).json() as Record<string, unknown>;
  assert.equal(body.deleted, true);
  assert.equal(body.revoked, false);
  assert.match(String(body.warning), /myaccount\.google\.com\/permissions/);
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
});

test('revoke treats Google invalid_token as already revoked', async () => {
  const { call, store } = setup();
  await store.save('1//stale', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  mockGoogle({ revoke: () => Response.json({ error: 'invalid_token' }, { status: 400 }) });
  const body = await (await call('/auth/google/revoke', { method: 'POST' })).json() as Record<string, unknown>;
  assert.equal(body.revoked, true);
  assert.equal(body.warning, undefined);
});

test('revoke with nothing stored → 404 and no Google call', async () => {
  const { call } = setup();
  const calls = mockGoogle({});
  const res = await call('/auth/google/revoke', { method: 'POST' });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('revoke refuses cross-site browser requests', async () => {
  const { call, store, kv } = setup();
  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  const calls = mockGoogle({});
  for (const headers of [{ origin: 'https://evil.example.net' }, { origin: `http://${HOST}` }, { 'sec-fetch-site': 'cross-site' }]) {
    const res = await call('/auth/google/revoke', { method: 'POST', headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.equal(calls.length, 0);
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
  // The same-origin form on the status page is accepted.
  mockGoogle({});
  const ok = await call('/auth/google/revoke', { method: 'POST', headers: { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' } });
  assert.equal(ok.status, 200);
});

test('GET on revoke is not a state change', async () => {
  const { call, store, kv } = setup();
  await store.save('1//stored', { scope: GOOGLE_SCOPE_READONLY, clientId: 'c' });
  const res = await call('/auth/google/revoke');
  assert.equal(res.status, 404);
  assert.ok(kv.data.has(KV_KEYS.refreshToken));
});
