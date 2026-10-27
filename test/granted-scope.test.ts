/**
 * Write-tier checks use the scope Google actually granted to the account
 * that owns the property. Legacy records without that field fall back to
 * the TOOL_TIER scope and show as unknown in status output.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import { encryptString, importEncryptionKey } from '../src/lib/google-oauth/crypto.js';
import { GoogleTokenStore, KV_KEYS } from '../src/lib/google-oauth/store.js';
import { GOOGLE_SCOPE_FULL, GOOGLE_SCOPE_READONLY, parseConfig, setEnvSource } from '../src/lib/config.js';
import { hasWebmastersWriteScope } from '../src/lib/google-oauth/google.js';
import type { ServerServices } from '../src/mcp/context.js';
import { registerSitemapsTools } from '../src/tools/sitemaps.js';
import { registerCapabilitiesTools } from '../src/tools/capabilities.js';
import { buildApp } from '../src/app.js';
import { MemoryKv } from './helpers/memory-kv.js';

const KEY = randomBytes(32).toString('base64');
const CLIENT = 'cid';
const HOST = 'gsc.example.com';
const TOKEN = 'b'.repeat(48);
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnvSource(process.env as Record<string, unknown>);
});

function toolsOf(server: McpServer) {
  return (server as unknown as {
    _registeredTools: Record<string, { executor: (a: unknown, c: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  })._registeredTools;
}

test('hasWebmastersWriteScope requires the non-readonly webmasters scope', () => {
  assert.equal(hasWebmastersWriteScope(GOOGLE_SCOPE_FULL), true);
  assert.equal(hasWebmastersWriteScope(`${GOOGLE_SCOPE_READONLY} openid`), false);
  assert.equal(hasWebmastersWriteScope(`${GOOGLE_SCOPE_FULL} openid email`), true);
});

test('save records the scope Google returned; omitting it leaves granted scope unknown', async () => {
  const store = new GoogleTokenStore(new MemoryKv(), KEY);
  await store.save('rt-known', { scope: `${GOOGLE_SCOPE_FULL} openid`, grantedScope: `${GOOGLE_SCOPE_FULL} openid`, clientId: CLIENT, email: 'ada@example.com' });
  assert.equal((await store.loadMeta('ada@example.com'))?.grantedScope, `${GOOGLE_SCOPE_FULL} openid`);
  await store.save('rt-unknown', { scope: GOOGLE_SCOPE_READONLY, clientId: CLIENT, email: 'bob@example.com' });
  assert.equal((await store.loadMeta('bob@example.com'))?.grantedScope, null);
});

test('a pre-granted-scope KV record migrates as unknown and falls back to config', async () => {
  const kv = new MemoryKv();
  const key = await importEncryptionKey(KEY);
  kv.data.set(KV_KEYS.account('ada@example.com'), JSON.stringify({
    v: 1,
    refresh_token: await encryptString(key, 'rt-legacy', 'gsc-mcp-ts:google-refresh-token:v1:ada@example.com'),
    scope: GOOGLE_SCOPE_READONLY,
    client_id: CLIENT,
    email: 'ada@example.com',
    stored_at: '2026-10-01T00:00:00.000Z',
  }));
  kv.data.set(KV_KEYS.accountIndex, JSON.stringify({ v: 1, ids: ['ada@example.com'] }));
  const store = new GoogleTokenStore(kv, KEY);
  const loaded = await store.loadRefreshToken('ada@example.com');
  assert.equal(loaded?.refreshToken, 'rt-legacy');
  assert.equal(loaded?.meta.grantedScope, null);
  assert.equal(loaded?.meta.scope, GOOGLE_SCOPE_READONLY);
});

test('a refresh token response that includes scope persists it on the account', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', { scope: GOOGLE_SCOPE_READONLY, clientId: CLIENT, email: 'ada@example.com' });
  assert.equal((await store.loadMeta('ada@example.com'))?.grantedScope, null);
  const provider = new TokenProvider(
    { clientId: CLIENT, clientSecret: 'sec', scopes: [GOOGLE_SCOPE_READONLY] },
    (async () => Response.json({ access_token: 'at', expires_in: 3600, scope: GOOGLE_SCOPE_FULL })) as typeof fetch,
    { store },
  );
  assert.equal(await provider.getAccessToken('ada@example.com'), 'at');
  assert.equal((await store.loadMeta('ada@example.com'))?.grantedScope, GOOGLE_SCOPE_FULL);
  const status = await provider.status({ fresh: true });
  assert.equal(status.accounts[0]?.stored?.grantedScope, GOOGLE_SCOPE_FULL);
});

async function writeHarness(opts: {
  granted?: Record<string, string | null>;
  scopes?: string[];
  allowDestructive?: boolean;
}) {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  const granted = opts.granted ?? { 'ada@example.com': GOOGLE_SCOPE_READONLY, 'bob@example.com': GOOGLE_SCOPE_FULL };
  for (const [email, scope] of Object.entries(granted)) {
    await store.save(`rt-${email.split('@')[0]}`, {
      scope: scope ?? GOOGLE_SCOPE_READONLY,
      ...(scope ? { grantedScope: scope } : {}),
      clientId: CLIENT,
      email,
    });
  }
  const tokenFetch = (async (_u: unknown, init?: RequestInit) => {
    const rt = new URLSearchParams(String(init?.body)).get('refresh_token')!;
    return Response.json({ access_token: `at-${rt}`, expires_in: 3600 });
  }) as typeof fetch;
  const scopes = opts.scopes ?? [GOOGLE_SCOPE_FULL];
  const tokenProvider = new TokenProvider({ clientId: CLIENT, clientSecret: 'sec', scopes }, tokenFetch, { store });
  const calls: { path: string; token: string; method: string }[] = [];
  const gscFetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = (init?.headers as Record<string, string>).Authorization!.replace('Bearer ', '');
    calls.push({ path: decodeURIComponent(url.pathname), token, method: init?.method ?? 'GET' });
    if (url.pathname === '/webmasters/v3/sites') {
      return Response.json({
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: token.includes('ada') ? 'siteOwner' : 'siteRestrictedUser' },
          { siteUrl: 'https://other.example/', permissionLevel: token.includes('bob') ? 'siteOwner' : 'siteRestrictedUser' },
        ],
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  setEnvSource({
    TOOL_TIER: !scopes.includes(GOOGLE_SCOPE_FULL) ? 'read' : opts.allowDestructive ? 'destructive' : 'write',
  });
  const config = parseConfig();
  const gsc = new GscClient({ tokenProvider, fetchImpl: gscFetch });
  const svc: ServerServices = { config, tokenProvider, gsc, tokenStore: store };
  const server = new McpServer({ name: 't', version: '0' });
  registerSitemapsTools(server, svc);
  registerCapabilitiesTools(server, svc);
  return { svc, store, calls, tools: toolsOf(server) };
}

test('submit_sitemap is refused when the property account lacks the webmasters scope', async () => {
  const { tools, calls } = await writeHarness({});
  const result = await tools.submit_sitemap!.executor(
    { site_url: 'sc-domain:example.com', sitemap_url: 'https://example.com/sitemap.xml' },
    {},
  );
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as {
    error: string;
    account: string;
    granted_scope: string;
    required_scope: string;
    resolution: string;
  };
  assert.equal(body.error, 'insufficient_granted_scope');
  assert.equal(body.account, 'ada@example.com');
  assert.equal(body.granted_scope, GOOGLE_SCOPE_READONLY);
  assert.equal(body.required_scope, GOOGLE_SCOPE_FULL);
  assert.match(body.resolution, /\/auth\/google/);
  assert.match(body.resolution, /TOOL_TIER=write or destructive/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('submit_sitemap uses the account that owns the property when another account has write scope', async () => {
  const { tools, calls } = await writeHarness({});
  const result = await tools.submit_sitemap!.executor(
    { site_url: 'https://other.example/', sitemap_url: 'https://other.example/sitemap.xml' },
    {},
  );
  assert.notEqual(result.isError, true, result.content[0]!.text);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').map((c) => c.token), ['at-rt-bob']);
});

test('unknown granted scope falls back to the TOOL_TIER scope for the write check', async () => {
  const allowed = await writeHarness({
    granted: { 'ada@example.com': null },
    scopes: [GOOGLE_SCOPE_FULL],
  });
  const ok = await allowed.tools.submit_sitemap!.executor(
    { site_url: 'sc-domain:example.com', sitemap_url: 'https://example.com/sitemap.xml' },
    {},
  );
  assert.notEqual(ok.isError, true, ok.content[0]!.text);

  const denied = await writeHarness({
    granted: { 'ada@example.com': null },
    scopes: [GOOGLE_SCOPE_READONLY],
  });
  const result = await denied.tools.submit_sitemap!.executor(
    { site_url: 'sc-domain:example.com', sitemap_url: 'https://example.com/sitemap.xml' },
    {},
  );
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as { granted_scope: string; resolution: string };
  assert.equal(body.granted_scope, 'unknown');
  assert.match(body.resolution, /TOOL_TIER=write or destructive/);
});

test('get_capabilities lists per-account granted scope and /health stays counts-only', async () => {
  const { tools } = await writeHarness({
    granted: { 'ada@example.com': GOOGLE_SCOPE_READONLY, 'bob@example.com': GOOGLE_SCOPE_FULL },
  });
  const text = (await tools.get_capabilities!.executor({}, {})).content[0]!.text;
  assert.match(text, /ada@example\.com.*granted scope readonly/);
  assert.match(text, /bob@example\.com.*granted scope full/);
  assert.doesNotMatch(text, /rt-ada|at-rt/);

  const kv = new MemoryKv();
  setEnvSource({
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: HOST,
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'sec',
    TOOL_TIER: 'write',
    GSC_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
  });
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('1//ada', { scope: GOOGLE_SCOPE_FULL, grantedScope: GOOGLE_SCOPE_FULL, clientId: CLIENT, email: 'ada@example.com' });
  const app = buildApp('worker');
  const health = await (await app.request(`https://${HOST}/health`, { headers: { host: HOST } })).json() as Record<string, unknown>;
  assert.deepEqual(health.google_accounts, { total: 1, available: 1 });
  assert.equal('granted_scope' in health, false);
  assert.ok(!JSON.stringify(health).includes('ada@example.com'));

  const status = await (await app.request(`https://${HOST}/auth/google/status`, {
    headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
  })).json() as { accounts: { granted_scope: string }[]; stored: { granted_scope: string } };
  assert.equal(status.stored.granted_scope, GOOGLE_SCOPE_FULL);
  assert.deepEqual(status.accounts.map((a) => a.granted_scope), [GOOGLE_SCOPE_FULL]);
});
