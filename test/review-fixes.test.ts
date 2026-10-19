/** Regression tests for the code-review findings (P1/P2 fixes). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { parseConfig, validateHttpConfig } from '../src/lib/config.js';
import { buildAuthenticator } from '../src/lib/mcp-auth/index.js';
import { buildCfAccessAuthenticator } from '../src/lib/mcp-auth/cf-access.js';
import { McpServer } from '@modelcontextprotocol/server';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { Config } from '../src/lib/config.js';
import type { ServerServices } from '../src/mcp/context.js';
import { registerAdvancedAnalyticsTools } from '../src/tools/analytics-advanced.js';
import { registerPropertiesTools } from '../src/tools/properties.js';

// ---------- P1-1: MCP_AUTH_MODE ',' must not authenticate ----------

test('MCP_AUTH_MODE="," is rejected by startup validation', () => {
  process.env.MCP_AUTH_MODE = ',';
  const cfg = parseConfig();
  const errors = validateHttpConfig(cfg, 'node');
  assert.ok(errors.some((e) => e.includes('contains no valid modes')), errors.join('\n'));
  delete process.env.MCP_AUTH_MODE;
});

test('buildAuthenticator with zero modes fails closed', () => {
  const cfg = {
    auth: { rawMode: 'none', modes: [], bearerHeader: 'authorization' },
  } as unknown as Config;
  const result = buildAuthenticator(cfg, []);
  assert.equal(result.ok, false);
});

// ---------- P2-13: cf-access token without exp is rejected ----------

const TEAM = 'https://t.cloudflareaccess.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'k1';
const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
const cfAuth = buildCfAccessAuthenticator(
  { teamDomain: TEAM, aud: ['a1'], allowedEmails: [], allowedServiceTokens: [] },
  { jwks: { keys: [publicJwk] } },
);

test('cf-access: token without exp → 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: 'a@b.c' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(TEAM)
    .setAudience('a1')
    .setSubject('s1')
    .setIssuedAt(now)
    .sign(privateKey);
  const out = await cfAuth(new Request('http://x/', { method: 'POST', headers: { 'cf-access-jwt-assertion': token } }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

// ---------- Tool-level: pagination + googleNews mapping (P2-4 / P2-7) ----------

function fakeServices(respond: (body: Record<string, unknown>) => unknown, calls: Record<string, unknown>[]): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (() => Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })))) as typeof fetch,
  );
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200 }));
  }) as typeof fetch;
  const gsc = new GscClient({ tokenProvider, fetchImpl });
  const config = parseConfig();
  return { config, tokenProvider, gsc };
}

async function runTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const registered = (server as unknown as { _registeredTools: Map<string, { executor: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }> }> | Record<string, { executor: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
  const tool = registered instanceof Map ? registered.get(name) : registered[name];
  assert.ok(tool, `tool ${name} registered`);
  const result = await tool.executor(args, {});
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('add_site: PUT with empty success body is reported as success (P1-3)', async () => {
  const calls: { method?: string; path?: string }[] = [];
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (() => Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })))) as typeof fetch,
  );
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    calls.push({ method: init?.method, path: String(input) });
    return Promise.resolve(new Response('', { status: 200 })); // empty body, like sites.add
  }) as typeof fetch;
  const config = { ...parseConfig(), scopeTier: 'destructive', allowDestructive: true } as Config;
  const svc = { config, tokenProvider, gsc: new GscClient({ tokenProvider, fetchImpl }) };
  const server = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(server, svc);
  const out = await runToolText(server, 'add_site', { site_url: 'https://newsite.example.com/' });
  assert.match(out, /has been added/);
  assert.equal(calls[0]!.method, 'PUT');
});

async function runToolText(server: McpServer, name: string, args: Record<string, unknown>): Promise<string> {
  const registered = (server as unknown as { _registeredTools: Record<string, { executor: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
  const tool = registered[name];
  assert.ok(tool, `tool ${name} registered`);
  const result = await tool.executor(args, {});
  return result.content[0]!.text;
}

test('auto-pagination fetches a second page when max_rows > row_limit', async () => {
  const calls: Record<string, unknown>[] = [];
  // 30 rows total; each API page returns up to its requested rowLimit.
  const allRows = Array.from({ length: 28 }, (_, i) => ({ keys: [`q${i}`], clicks: i, impressions: 1, ctr: 0.1, position: 1 }));
  const svc = fakeServices((body) => {
    const start = Number(body.startRow ?? 0);
    const limit = Number(body.rowLimit ?? 25);
    return { rows: allRows.slice(start, start + limit) };
  }, calls);

  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const out = await runTool(server, 'get_advanced_search_analytics', {
    site_url: 'sc-domain:x.com',
    dimensions: 'query',
    search_type: 'web',
    sort_by: 'clicks',
    sort_direction: 'descending',
    row_limit: 25,
    max_rows: 30,
    start_row: 0,
  });
  const pagination = out.pagination as Record<string, unknown>;
  assert.equal(pagination.row_count, 28);
  assert.equal(pagination.pages_fetched, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.startRow, 25);
  assert.equal(pagination.has_more, false);
});

test('search_type GOOGLENEWS maps to canonical wire value googleNews', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = fakeServices(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  await runTool(server, 'get_advanced_search_analytics', {
    site_url: 'sc-domain:x.com',
    search_type: 'GOOGLENEWS',
    dimensions: 'query',
    row_limit: 1000,
    sort_by: 'clicks',
    sort_direction: 'descending',
  });
  assert.equal(calls[0]!.type, 'googleNews');
});

test('hourly_all without hour dimension is rejected before any API call', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = fakeServices(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const out = await runTool(server, 'get_advanced_search_analytics', {
    site_url: 'sc-domain:x.com',
    dimensions: 'query',
    search_type: 'web',
    sort_by: 'clicks',
    sort_direction: 'descending',
    data_state: 'hourly_all',
  });
  assert.ok('error' in out);
  assert.equal(calls.length, 0);
});
