/**
 * Several Google accounts per deployment: KV storage keyed by email, lazy
 * migration of the single-account record, per-account access tokens,
 * property → account routing (exact property identity, permission ranking, 403 fallback), merged
 * list_properties, add_site account choice, and the admin routes.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { ENV_ACCOUNT_ID, TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import { encryptString, importEncryptionKey } from '../src/lib/google-oauth/crypto.js';
import { GoogleTokenStore, KV_KEYS, LEGACY_ACCOUNT_ID } from '../src/lib/google-oauth/store.js';
import { GOOGLE_SCOPE_FULL, GOOGLE_SCOPE_READONLY, parseConfig, setEnvSource } from '../src/lib/config.js';
import type { ServerServices } from '../src/mcp/context.js';
import { registerPropertiesTools } from '../src/tools/properties.js';
import { buildApp } from '../src/app.js';
import { MemoryKv } from './helpers/memory-kv.js';

const KEY = randomBytes(32).toString('base64');
const CLIENT = 'cid';
const google = { clientId: CLIENT, clientSecret: 'sec', scopes: [GOOGLE_SCOPE_READONLY] };
const meta = (email?: string) => ({ scope: GOOGLE_SCOPE_READONLY, clientId: CLIENT, ...(email ? { email } : {}) });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnvSource(process.env as Record<string, unknown>);
});

/** Write a record the way the single-account version did (legacy key and AAD). */
async function writeLegacy(kv: MemoryKv, refreshToken: string, email?: string) {
  const key = await importEncryptionKey(KEY);
  kv.data.set(KV_KEYS.refreshToken, JSON.stringify({
    v: 1,
    refresh_token: await encryptString(key, refreshToken, 'gsc-mcp-ts:google-refresh-token:v1'),
    scope: GOOGLE_SCOPE_READONLY,
    client_id: CLIENT,
    ...(email ? { email } : {}),
    stored_at: '2026-10-01T00:00:00.000Z',
  }));
}

// ---------- storage ----------

test('accounts are stored per email; re-authorizing one replaces only that account', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', meta('Ada@Example.com'));
  await store.save('rt-bob', meta('bob@example.com'));
  assert.deepEqual(await store.accountIds(), ['ada@example.com', 'bob@example.com']);
  assert.ok(!kv.data.get(KV_KEYS.account('ada@example.com'))!.includes('rt-ada'), 'encrypted at rest');

  await store.save('rt-ada-2', meta('ada@example.com'));
  assert.equal((await store.loadRefreshToken('ada@example.com'))?.refreshToken, 'rt-ada-2');
  assert.equal((await store.loadRefreshToken('bob@example.com'))?.refreshToken, 'rt-bob');
  assert.deepEqual(await store.accountIds(), ['ada@example.com', 'bob@example.com']);

  const listed = await store.listAccounts();
  assert.deepEqual(listed.map((a) => [a.id, a.meta?.email, a.error]), [
    ['ada@example.com', 'ada@example.com', null],
    ['bob@example.com', 'bob@example.com', null],
  ]);
  assert.ok(!JSON.stringify(listed).includes('rt-'), 'listing never carries tokens');
});

test('a record cannot be replayed under another account key', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', meta('ada@example.com'));
  await store.save('rt-bob', meta('bob@example.com'));
  kv.data.set(KV_KEYS.account('bob@example.com'), kv.data.get(KV_KEYS.account('ada@example.com'))!);
  await assert.rejects(() => store.loadRefreshToken('bob@example.com'), /cannot be decrypted/);
});

test('remove() deletes one account and keeps the others', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', meta('ada@example.com'));
  await store.save('rt-bob', meta('bob@example.com'));
  assert.equal(await store.remove('ada@example.com'), true);
  assert.equal(await store.remove('ada@example.com'), false);
  assert.deepEqual(await store.accountIds(), ['bob@example.com']);
  assert.equal(kv.data.has(KV_KEYS.account('ada@example.com')), false);
});

// ---------- legacy migration ----------

test('legacy single-account record with an email migrates to its account key on first read', async () => {
  const kv = new MemoryKv();
  await writeLegacy(kv, 'rt-legacy', 'Ada@Example.com');
  const store = new GoogleTokenStore(kv, KEY);
  assert.deepEqual(await store.accountIds(), ['ada@example.com']);
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false, 'legacy key removed after the copy');
  const loaded = await store.loadRefreshToken('ada@example.com');
  assert.equal(loaded?.refreshToken, 'rt-legacy');
  assert.equal(loaded?.meta.storedAt, '2026-10-01T00:00:00.000Z', 'metadata kept');
});

test('a failed migration write keeps the legacy record readable', async () => {
  const kv = new MemoryKv();
  await writeLegacy(kv, 'rt-legacy', 'ada@example.com');
  const realPut = kv.put.bind(kv);
  kv.put = async () => { throw new Error('KV unavailable'); };
  const store = new GoogleTokenStore(kv, KEY);
  assert.deepEqual(await store.accountIds(), [LEGACY_ACCOUNT_ID]);
  assert.equal((await store.loadRefreshToken(LEGACY_ACCOUNT_ID))?.refreshToken, 'rt-legacy');
  kv.put = realPut;
  assert.deepEqual(await store.accountIds(), ['ada@example.com']);
});

test('legacy record without an email stays as the default account next to new ones', async () => {
  const kv = new MemoryKv();
  await writeLegacy(kv, 'rt-legacy');
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-bob', meta('bob@example.com'));
  assert.deepEqual(await store.accountIds(), [LEGACY_ACCOUNT_ID, 'bob@example.com']);
  assert.equal((await store.loadRefreshToken(LEGACY_ACCOUNT_ID))?.refreshToken, 'rt-legacy');
});

test('authorizing the legacy account again replaces the legacy record', async () => {
  const kv = new MemoryKv();
  await writeLegacy(kv, 'rt-legacy', 'ada@example.com');
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-new', meta('ada@example.com'));
  assert.equal(kv.data.has(KV_KEYS.refreshToken), false);
  assert.deepEqual(await store.accountIds(), ['ada@example.com']);
  assert.equal((await store.loadRefreshToken('ada@example.com'))?.refreshToken, 'rt-new');
});

// ---------- per-account tokens and routing ----------

interface Site { siteUrl: string; permissionLevel: string }

/**
 * Token endpoint mints `at-<refresh token>`; the GSC API answers per access
 * token from `sites`, and `deny` lists access tokens that get 403 on
 * everything but sites.list.
 */
async function harness(opts: { sites: Record<string, Site[]>; deny?: string[]; env?: string; accounts?: string[] }) {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  for (const email of opts.accounts ?? ['ada@example.com', 'bob@example.com']) {
    await store.save(`rt-${email.split('@')[0]}`, meta(email));
  }
  const refreshes: string[] = [];
  const tokenFetch = (async (_u: unknown, init?: RequestInit) => {
    const rt = new URLSearchParams(String(init?.body)).get('refresh_token')!;
    refreshes.push(rt);
    return Response.json({ access_token: `at-${rt}`, expires_in: 3600 });
  }) as typeof fetch;
  const tokenProvider = new TokenProvider(
    { ...google, ...(opts.env ? { refreshToken: opts.env } : {}) },
    tokenFetch,
    { store },
  );
  const calls: { path: string; token: string; method: string; body: unknown }[] = [];
  const gscFetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = (init?.headers as Record<string, string>).Authorization!.replace('Bearer ', '');
    calls.push({
      path: decodeURIComponent(url.pathname),
      token,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname === '/webmasters/v3/sites') return Response.json({ siteEntry: opts.sites[token] ?? [] });
    if (opts.deny?.includes(token)) {
      return Response.json({ error: { code: 403, message: 'User does not have sufficient permission' } }, { status: 403 });
    }
    return Response.json({ rows: [], servedBy: token });
  }) as typeof fetch;
  const gsc = new GscClient({ tokenProvider, fetchImpl: gscFetch });
  const svc: ServerServices = { config: parseConfig(), tokenProvider, gsc, tokenStore: store };
  return { store, tokenProvider, gsc, svc, calls, refreshes };
}

const queryPath = (site: string) => `/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;

test('each account gets its own access token and cache; env is one more account', async () => {
  const { tokenProvider, refreshes } = await harness({ sites: {}, env: 'rt-env' });
  assert.deepEqual(await tokenProvider.accountIds(), ['ada@example.com', 'bob@example.com', ENV_ACCOUNT_ID]);
  assert.equal(await tokenProvider.getAccessToken('ada@example.com'), 'at-rt-ada');
  assert.equal(await tokenProvider.getAccessToken('bob@example.com'), 'at-rt-bob');
  assert.equal(await tokenProvider.getAccessToken(ENV_ACCOUNT_ID), 'at-rt-env');
  assert.equal(await tokenProvider.getAccessToken(), 'at-rt-ada', 'default is the first KV account');
  assert.equal(await tokenProvider.getAccessToken('bob@example.com'), 'at-rt-bob');
  assert.deepEqual(refreshes, ['rt-ada', 'rt-bob', 'rt-env'], 'cached per account');
  const status = await tokenProvider.status();
  assert.deepEqual(status.accounts.map((a) => [a.id, a.source, a.available]), [
    ['ada@example.com', 'kv', true],
    ['bob@example.com', 'kv', true],
    [ENV_ACCOUNT_ID, 'env', true],
  ]);
});

test('routing picks the account with the highest permission on the property', async () => {
  const site = 'sc-domain:example.com';
  const { gsc, calls } = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: site, permissionLevel: 'siteRestrictedUser' }],
      'at-rt-bob': [{ siteUrl: site, permissionLevel: 'siteOwner' }],
    },
  });
  const out = await gsc.request<{ servedBy: string }>(queryPath(site), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-bob');
  // The map is cached: a second call does not list sites again.
  await gsc.request(queryPath(site), { method: 'POST', body: {} });
  assert.equal(calls.filter((c) => c.path === '/webmasters/v3/sites').length, 2, 'one sites.list per account');
});

test('routing uses the only account that lists a property, also for inspection bodies', async () => {
  const site = 'https://bob.example/';
  const { gsc } = await harness({
    sites: { 'at-rt-ada': [], 'at-rt-bob': [{ siteUrl: site, permissionLevel: 'siteFullUser' }] },
  });
  const out = await gsc.request<{ servedBy: string }>('/v1/urlInspection/index:inspect', {
    method: 'POST',
    body: { inspectionUrl: `${site}page`, siteUrl: site },
  });
  assert.equal(out.servedBy, 'at-rt-bob');
});

test('a 403 from the best account falls back to the next account that lists the property', async () => {
  const site = 'sc-domain:example.com';
  const { gsc, calls } = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: site, permissionLevel: 'siteFullUser' }],
      'at-rt-bob': [{ siteUrl: site, permissionLevel: 'siteOwner' }],
    },
    deny: ['at-rt-bob'],
  });
  const out = await gsc.request<{ servedBy: string }>(queryPath(site), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-ada');
  const queries = calls.filter((c) => c.path.endsWith('/searchAnalytics/query')).map((c) => c.token);
  assert.deepEqual(queries, ['at-rt-bob', 'at-rt-ada']);
});

test('a 403 from the last candidate is reported', async () => {
  const site = 'sc-domain:example.com';
  const { gsc } = await harness({
    sites: { 'at-rt-ada': [{ siteUrl: site, permissionLevel: 'siteOwner' }], 'at-rt-bob': [] },
    deny: ['at-rt-ada'],
  });
  await assert.rejects(() => gsc.request(queryPath(site), { method: 'POST', body: {} }), (e: unknown) => (e as { status?: number }).status === 403);
});

test('a property no account lists, or a request about no property, uses the default account', async () => {
  const { gsc } = await harness({ sites: { 'at-rt-ada': [], 'at-rt-bob': [] } });
  const out = await gsc.request<{ servedBy: string }>(queryPath('https://unknown.example/'), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-ada');
});

const EXAMPLE_PROPERTIES = {
  domain: 'sc-domain:example.com',
  httpsRoot: 'https://example.com/',
  httpRoot: 'http://example.com/',
  blog: 'https://example.com/blog/',
  blogCased: 'https://example.com/Blog/',
} as const;

function exampleHarness() {
  return harness({
    sites: {
      'at-rt-ada': [
        { siteUrl: EXAMPLE_PROPERTIES.domain, permissionLevel: 'siteOwner' },
        { siteUrl: EXAMPLE_PROPERTIES.httpsRoot, permissionLevel: 'siteRestrictedUser' },
        { siteUrl: EXAMPLE_PROPERTIES.blogCased, permissionLevel: 'siteOwner' },
      ],
      'at-rt-bob': [
        { siteUrl: EXAMPLE_PROPERTIES.httpsRoot, permissionLevel: 'siteOwner' },
        { siteUrl: EXAMPLE_PROPERTIES.httpRoot, permissionLevel: 'siteOwner' },
        { siteUrl: EXAMPLE_PROPERTIES.blog, permissionLevel: 'siteFullUser' },
      ],
    },
  });
}

test('exact property identity wins over another property on the same host', async () => {
  const { gsc, calls } = await exampleHarness();
  const cases: [string, string, string][] = [
    [EXAMPLE_PROPERTIES.domain, 'at-rt-ada', EXAMPLE_PROPERTIES.domain],
    [EXAMPLE_PROPERTIES.httpsRoot, 'at-rt-bob', EXAMPLE_PROPERTIES.httpsRoot],
    [EXAMPLE_PROPERTIES.httpRoot, 'at-rt-bob', EXAMPLE_PROPERTIES.httpRoot],
    [EXAMPLE_PROPERTIES.blog, 'at-rt-bob', EXAMPLE_PROPERTIES.blog],
    [EXAMPLE_PROPERTIES.blogCased, 'at-rt-ada', EXAMPLE_PROPERTIES.blogCased],
  ];
  for (const [site, token, resolved] of cases) {
    calls.length = 0;
    const out = await gsc.request<{ servedBy: string }>(queryPath(site), { method: 'POST', body: {} });
    assert.equal(out.servedBy, token, site);
    const query = calls.find((c) => c.path.endsWith('/searchAnalytics/query'));
    assert.equal(query?.path, `/webmasters/v3/sites/${resolved}/searchAnalytics/query`, site);
  }
});

test('a subdirectory property never collapses to the URL-prefix root', async () => {
  const { gsc, calls } = await exampleHarness();
  const out = await gsc.request<{ servedBy: string }>(queryPath('https://example.com/blog'), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-bob');
  const query = calls.find((c) => c.path.endsWith('/searchAnalytics/query'));
  assert.equal(query?.path, `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.blog}/searchAnalytics/query`);
});

test('host matching is case-insensitive and the listed path case is preserved', async () => {
  const { gsc, calls } = await exampleHarness();
  const root = await gsc.request<{ servedBy: string }>(queryPath('https://EXAMPLE.com/'), { method: 'POST', body: {} });
  assert.equal(root.servedBy, 'at-rt-bob');
  const blog = await gsc.request<{ servedBy: string }>(queryPath('https://example.com/Blog/'), { method: 'POST', body: {} });
  assert.equal(blog.servedBy, 'at-rt-ada');
  const queries = calls.filter((c) => c.path.endsWith('/searchAnalytics/query')).map((c) => c.path);
  assert.deepEqual(queries, [
    `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.httpsRoot}/searchAnalytics/query`,
    `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.blogCased}/searchAnalytics/query`,
  ]);
});

test('a bare domain uses sc-domain, then https root, then http root', async () => {
  const { gsc, calls } = await exampleHarness();
  const out = await gsc.request<{ servedBy: string }>(queryPath('example.com'), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-ada');
  const query = calls.find((c) => c.path.endsWith('/searchAnalytics/query'));
  assert.equal(query?.path, `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.domain}/searchAnalytics/query`);

  const httpsOnly = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: EXAMPLE_PROPERTIES.httpsRoot, permissionLevel: 'siteOwner' }],
      'at-rt-bob': [{ siteUrl: EXAMPLE_PROPERTIES.httpRoot, permissionLevel: 'siteOwner' }],
    },
  });
  const httpsHit = await httpsOnly.gsc.request<{ servedBy: string }>(queryPath('EXAMPLE.com'), { method: 'POST', body: {} });
  assert.equal(httpsHit.servedBy, 'at-rt-ada');

  const httpOnly = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: EXAMPLE_PROPERTIES.blog, permissionLevel: 'siteOwner' }],
      'at-rt-bob': [{ siteUrl: EXAMPLE_PROPERTIES.httpRoot, permissionLevel: 'siteOwner' }],
    },
  });
  const httpHit = await httpOnly.gsc.request<{ servedBy: string }>(queryPath('example.com'), { method: 'POST', body: {} });
  assert.equal(httpHit.servedBy, 'at-rt-bob');
});

test('an ambiguous site URL lists the candidate properties and does not guess', async () => {
  const { gsc, calls } = await exampleHarness();
  await assert.rejects(
    () => gsc.request(queryPath('https://example.com/shop/'), { method: 'POST', body: {} }),
    (e: unknown) => {
      assert.equal((e as { name?: string }).name, 'AmbiguousPropertyError');
      const message = (e as Error).message;
      assert.match(message, /https:\/\/example\.com\/shop\//);
      assert.match(message, /sc-domain:example\.com/);
      assert.match(message, /https:\/\/example\.com\//);
      assert.match(message, /http:\/\/example\.com\//);
      assert.match(message, /https:\/\/example\.com\/blog\//);
      assert.match(message, /https:\/\/example\.com\/Blog\//);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.path.endsWith('/searchAnalytics/query')).length, 0);

  const subdirsOnly = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: EXAMPLE_PROPERTIES.blog, permissionLevel: 'siteOwner' }],
      'at-rt-bob': [{ siteUrl: 'https://example.com/docs/', permissionLevel: 'siteOwner' }],
    },
  });
  await assert.rejects(
    () => subdirsOnly.gsc.request(queryPath('example.com'), { method: 'POST', body: {} }),
    (e: unknown) => {
      const message = (e as Error).message;
      assert.match(message, /Ambiguous Search Console property 'example\.com'/);
      assert.match(message, /https:\/\/example\.com\/blog\//);
      assert.match(message, /https:\/\/example\.com\/docs\//);
      return true;
    },
  );
});

test('routing a 403 fallback stays on the exact resolved property', async () => {
  const { gsc, calls } = await harness({
    sites: {
      'at-rt-ada': [
        { siteUrl: EXAMPLE_PROPERTIES.httpsRoot, permissionLevel: 'siteFullUser' },
        { siteUrl: EXAMPLE_PROPERTIES.domain, permissionLevel: 'siteOwner' },
      ],
      'at-rt-bob': [{ siteUrl: EXAMPLE_PROPERTIES.httpsRoot, permissionLevel: 'siteOwner' }],
    },
    deny: ['at-rt-bob'],
  });
  const out = await gsc.request<{ servedBy: string }>(queryPath('https://EXAMPLE.com'), { method: 'POST', body: {} });
  assert.equal(out.servedBy, 'at-rt-ada');
  const queries = calls.filter((c) => c.path.endsWith('/searchAnalytics/query'));
  assert.deepEqual(queries.map((c) => [c.token, c.path]), [
    ['at-rt-bob', `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.httpsRoot}/searchAnalytics/query`],
    ['at-rt-ada', `/webmasters/v3/sites/${EXAMPLE_PROPERTIES.httpsRoot}/searchAnalytics/query`],
  ]);
});

test('inspection bodies are rewritten to the resolved property', async () => {
  const { gsc, calls } = await exampleHarness();
  const out = await gsc.request<{ servedBy: string }>('/v1/urlInspection/index:inspect', {
    method: 'POST',
    body: { inspectionUrl: 'https://example.com/page', siteUrl: 'example.com' },
  });
  assert.equal(out.servedBy, 'at-rt-ada');
  const inspect = calls.find((c) => c.path === '/v1/urlInspection/index:inspect');
  assert.deepEqual(inspect?.body, { inspectionUrl: 'https://example.com/page', siteUrl: EXAMPLE_PROPERTIES.domain });
});

test('with a single account no sites.list is made for routing', async () => {
  const site = 'sc-domain:example.com';
  const { gsc, calls } = await harness({ sites: {}, accounts: ['ada@example.com'] });
  await gsc.request(queryPath(site), { method: 'POST', body: {} });
  assert.deepEqual(calls.map((c) => c.path), [`/webmasters/v3/sites/${site}/searchAnalytics/query`]);
});

// ---------- tools ----------

function toolsOf(server: McpServer) {
  return (server as unknown as {
    _registeredTools: Record<string, { executor: (a: unknown, c: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  })._registeredTools;
}

test('list_properties merges all accounts and names the accounts per property', async () => {
  const shared = 'sc-domain:example.com';
  const { svc } = await harness({
    sites: {
      'at-rt-ada': [{ siteUrl: shared, permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'https://ada.example/', permissionLevel: 'siteOwner' }],
      'at-rt-bob': [{ siteUrl: shared, permissionLevel: 'siteOwner' }],
    },
  });
  const server = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(server, svc);
  const res = await toolsOf(server).list_properties!.executor({}, {});
  assert.notEqual(res.isError, true);
  const body = JSON.parse(res.content[0]!.text) as {
    count: number;
    properties: { site_url: string; permission_level: string; accounts: { account: string; permission_level: string }[] }[];
  };
  assert.equal(body.count, 2);
  const merged = body.properties.find((p) => p.site_url === shared)!;
  assert.equal(merged.permission_level, 'siteOwner');
  assert.deepEqual(merged.accounts, [
    { account: 'bob@example.com', permission_level: 'siteOwner' },
    { account: 'ada@example.com', permission_level: 'siteRestrictedUser' },
  ]);
  assert.deepEqual(body.properties.find((p) => p.site_url === 'https://ada.example/')!.accounts.map((a) => a.account), ['ada@example.com']);
});

test('add_site with several accounts requires an explicit account', async () => {
  const { svc, calls } = await harness({ sites: {} });
  const destructive = {
    ...svc,
    config: {
      ...svc.config,
      scopeTier: 'destructive' as const,
      allowDestructive: true,
      google: { ...svc.config.google, scopes: [GOOGLE_SCOPE_FULL] },
    },
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(server, destructive);
  const tools = toolsOf(server);

  const missing = await tools.add_site!.executor({ site_url: 'https://new.example/' }, {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /ada@example\.com, bob@example\.com/);

  const unknown = await tools.add_site!.executor({ site_url: 'https://new.example/', account: 'eve@example.com' }, {});
  assert.equal(unknown.isError, true);
  assert.equal(calls.length, 0);

  const ok = await tools.add_site!.executor({ site_url: 'https://new.example/', account: 'Bob@Example.com' }, {});
  assert.notEqual(ok.isError, true, ok.content[0]!.text);
  assert.deepEqual(calls.map((c) => [c.method, c.token]), [['PUT', 'at-rt-bob']]);
});

// ---------- admin routes ----------

const HOST = 'gsc.example.com';
const TOKEN = 'b'.repeat(48);

function app(env: Record<string, unknown> = {}) {
  const kv = new MemoryKv();
  setEnvSource({
    MCP_AUTH_MODE: 'bearer',
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: HOST,
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'sec',
    GSC_SCOPES: 'full',
    GSC_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
    ...env,
  });
  const a = buildApp('worker');
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    a.request(`https://${HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  const store = new GoogleTokenStore(kv, KEY);
  const fullMeta = (email: string) => ({ scope: GOOGLE_SCOPE_FULL, clientId: CLIENT, email });
  return { kv, call, store, fullMeta };
}

function mockRevoke() {
  const revoked: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === 'https://oauth2.googleapis.com/revoke') {
      revoked.push(new URLSearchParams(String(init?.body)).get('token')!);
      return new Response('{}');
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  return revoked;
}

test('GET /auth/google/accounts lists accounts without secrets', async () => {
  const { call, store, fullMeta } = app();
  await store.save('1//ada-secret', fullMeta('ada@example.com'));
  await store.save('1//bob-secret', fullMeta('bob@example.com'));
  const res = await call('/auth/google/accounts');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('secret'), 'no tokens');
  const body = JSON.parse(text) as { count: number; accounts: { account: string; source: string; scope: string; granted_scope: string; added_at: string; available: boolean }[] };
  assert.equal(body.count, 2);
  assert.deepEqual(body.accounts.map((a) => [a.account, a.source, a.available]), [
    ['ada@example.com', 'kv', true],
    ['bob@example.com', 'kv', true],
  ]);
  assert.ok(body.accounts.every((a) => a.scope === GOOGLE_SCOPE_FULL && a.granted_scope === 'unknown' && a.added_at));
  const html = await (await call('/auth/google/accounts', { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Disconnect ada@example\.com/);
  assert.match(html, /Disconnect bob@example\.com/);
});

test('removing an account needs the account when several are stored, and removes only that one', async () => {
  const { call, store, kv, fullMeta } = app();
  await store.save('1//ada', fullMeta('ada@example.com'));
  await store.save('1//bob', fullMeta('bob@example.com'));
  const revoked = mockRevoke();

  const ambiguous = await call('/auth/google/revoke', { method: 'POST' });
  assert.equal(ambiguous.status, 400);
  assert.match(await ambiguous.text(), /account_required[\s\S]*ada@example\.com, bob@example\.com/);
  assert.equal(revoked.length, 0);

  const notStored = await call('/auth/google/accounts/remove?account=eve@example.com', { method: 'POST' });
  assert.equal(notStored.status, 404);

  const res = await call('/auth/google/accounts/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'account=Bob%40Example.com',
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.account, 'bob@example.com');
  assert.deepEqual(body.remaining_accounts, ['ada@example.com']);
  assert.deepEqual(revoked, ['1//bob']);
  assert.equal(kv.data.has(KV_KEYS.account('bob@example.com')), false);
  assert.equal((await store.loadRefreshToken('ada@example.com'))?.refreshToken, '1//ada');
});

test('account removal is limited to GOOGLE_AUTH_ADMINS', async () => {
  const { call, store, fullMeta } = app({ GOOGLE_AUTH_ADMINS: 'ops@example.com' });
  await store.save('1//ada', fullMeta('ada@example.com'));
  const revoked = mockRevoke();
  assert.equal((await call('/auth/google/accounts/remove?account=ada@example.com', { method: 'POST' })).status, 403);
  assert.equal((await call('/auth/google/accounts')).status, 403);
  assert.equal(revoked.length, 0);
  assert.deepEqual(await store.accountIds(), ['ada@example.com']);
});

test('a second authorization adds an account instead of replacing the first', async () => {
  const { call, store } = app();
  const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
  for (const email of ['ada@example.com', 'bob@example.com']) {
    const start = await call('/auth/google');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    globalThis.fetch = (async () =>
      Response.json({ refresh_token: `1//${email}`, access_token: 'at', scope: GOOGLE_SCOPE_FULL, id_token: idToken(email) })) as typeof fetch;
    const res = await call(`/auth/google/callback?code=c&state=${state}`);
    assert.equal(res.status, 200, await res.clone().text());
  }
  assert.deepEqual(await store.accountIds(), ['ada@example.com', 'bob@example.com']);
  const health = await (await call('/health')).json() as { google_accounts: { total: number; available: number } };
  assert.deepEqual(health.google_accounts, { total: 2, available: 2 });
});

test('without an email in the ID token the callback asks userinfo for it', async () => {
  const { call, store } = app();
  const start = await call('/auth/google');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  globalThis.fetch = (async (input: unknown) =>
    String(input) === 'https://openidconnect.googleapis.com/v1/userinfo'
      ? Response.json({ email: 'cara@example.com' })
      : Response.json({ refresh_token: '1//cara', access_token: 'at', scope: GOOGLE_SCOPE_FULL })) as typeof fetch;
  assert.equal((await call(`/auth/google/callback?code=c&state=${state}`)).status, 200);
  assert.deepEqual(await store.accountIds(), ['cara@example.com']);
});
