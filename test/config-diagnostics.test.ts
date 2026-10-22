/**
 * Operator-facing diagnostics: logged startup errors behind the 503, the
 * missing-MCP_ALLOWED_HOSTS warning on Workers, and get_capabilities flags.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { buildApp } from '../src/app.js';
import {
  GOOGLE_SCOPE_FULL,
  GOOGLE_SCOPE_READONLY,
  INVALID_CONFIG_MESSAGE,
  parseConfig,
  setEnvSource,
  validateHttpWarnings,
} from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import { GoogleTokenStore } from '../src/lib/google-oauth/store.js';
import { registerCapabilitiesTools } from '../src/tools/capabilities.js';
import { registerAuthInfoTools } from '../src/tools/auth-info.js';
import { MemoryKv } from './helpers/memory-kv.js';

const HOST = 'gsc.example.com';
const TOKEN = 'b'.repeat(48);
const KEY = randomBytes(32).toString('base64');

afterEach(() => {
  setEnvSource(process.env as Record<string, unknown>);
});

function captureConsole(method: 'error' | 'warn') {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console[method] = original; } };
}

function request(app: ReturnType<typeof buildApp>, path: string) {
  return app.request(`https://${HOST}${path}`, { headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
}

test('invalid Worker config: requests get a generic 503 and the cause is logged once', async () => {
  setEnvSource({
    MCP_AUTH_MODE: 'bearer',
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: HOST,
    GSC_TOKENS: new MemoryKv(),
  });
  const err = captureConsole('error');
  try {
    const app = buildApp('worker');
    for (const path of ['/mcp', '/auth/google', '/mcp']) {
      const res = await request(app, path);
      assert.equal(res.status, 503);
      const body = await res.text();
      assert.equal(body, INVALID_CONFIG_MESSAGE);
      assert.doesNotMatch(body, /MCP auth/);
    }
  } finally {
    err.restore();
  }
  const mentions = err.lines.filter((l) => l.includes('TOKEN_ENCRYPTION_KEY'));
  assert.equal(mentions.length, 1, err.lines.join('\n'));
});

test('Worker without MCP_ALLOWED_HOSTS warns once that every request will be rejected', async () => {
  setEnvSource({ MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: TOKEN });
  const cfg = parseConfig();
  assert.ok(validateHttpWarnings(cfg, 'worker').some((w) => w.includes('MCP_ALLOWED_HOSTS')));
  assert.ok(!validateHttpWarnings(cfg).some((w) => w.includes('MCP_ALLOWED_HOSTS')), 'Node entry has its own check');

  const warn = captureConsole('warn');
  try {
    const app = buildApp('worker');
    assert.equal((await request(app, '/mcp')).status, 403);
    assert.equal((await request(app, '/mcp')).status, 403);
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.filter((l) => l.includes('MCP_ALLOWED_HOSTS')).length, 1, warn.lines.join('\n'));
});

interface RegisteredTool { executor: (args: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> }

async function capabilities(env: Record<string, unknown>, stored?: { scope: string; grantedScope?: string | null }): Promise<string> {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  if (stored) {
    await store.save('stored-refresh', {
      scope: stored.scope,
      clientId: 'cid',
      ...(stored.grantedScope ? { grantedScope: stored.grantedScope } : {}),
    });
  }
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google, undefined, { store: stored ? store : null });
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, { config, tokenProvider, gsc: new GscClient({ tokenProvider }) });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const result = await tools.get_capabilities!.executor({}, {});
  return result.content[0]!.text;
}

const CLIENT = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' };

test('get_capabilities flags a stored grant that does not cover GSC_SCOPES', async () => {
  const text = await capabilities(
    { ...CLIENT, GSC_SCOPES: 'full' },
    { scope: GOOGLE_SCOPE_READONLY, grantedScope: GOOGLE_SCOPE_READONLY },
  );
  assert.match(text, /does not cover the configured GSC_SCOPES/);
  assert.match(text, /\/auth\/google/);
});

test('get_capabilities treats a legacy record without granted scope as unknown', async () => {
  const text = await capabilities({ ...CLIENT, GSC_SCOPES: 'full' }, { scope: GOOGLE_SCOPE_READONLY });
  assert.doesNotMatch(text, /does not cover the configured GSC_SCOPES/);
  assert.match(text, /granted scope unknown/);
});

test('get_capabilities does not flag a stored full grant at the readonly tier', async () => {
  const text = await capabilities({ ...CLIENT }, { scope: GOOGLE_SCOPE_FULL });
  assert.doesNotMatch(text, /does not cover/);
  assert.match(text, /✅ Credentials configured/);
});

test('get_capabilities explains a refresh token without client credentials', async () => {
  const text = await capabilities({ GOOGLE_REFRESH_TOKEN: 'env-refresh' });
  assert.match(text, /refresh token is present \(source: env\)/);
  assert.match(text, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set/);
  assert.doesNotMatch(text, /Not authenticated/);
});

test('get_capabilities without any credentials says what is missing', async () => {
  const text = await capabilities({});
  assert.match(text, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set/);
  assert.match(text, /Not authenticated/);
});

test('get_capabilities does not report ready when the stored grant belongs to another client', async () => {
  const text = await capabilities({ GOOGLE_CLIENT_ID: 'new-client', GOOGLE_CLIENT_SECRET: 'sec' }, { scope: GOOGLE_SCOPE_READONLY });
  assert.doesNotMatch(text, /✅/);
  assert.match(text, /different OAuth client/);
});

test('get_capabilities at the read tier hints at both write and destructive tools', async () => {
  const text = await capabilities({ ...CLIENT });
  assert.match(text, /Not enabled at the current tier:/);
  assert.match(text, /write tools: set GSC_SCOPES=full/);
  assert.match(text, /destructive tools \(add_site\/delete_site\/delete_sitemap\): additionally set GSC_ALLOW_DESTRUCTIVE=true/);
  assert.doesNotMatch(text, /Write \(scope tier write\):/);
});

test('get_capabilities at the write tier lists write tools and hints only at destructive tools', async () => {
  const text = await capabilities({ ...CLIENT, GSC_SCOPES: 'full' });
  assert.match(text, /Write \(scope tier write\):\n  - submit_sitemap/);
  assert.match(text, /Not enabled at the current tier:/);
  assert.doesNotMatch(text, /write tools: set GSC_SCOPES=full/);
  assert.match(text, /destructive tools \(add_site\/delete_site\/delete_sitemap\): set GSC_ALLOW_DESTRUCTIVE=true/);
  assert.doesNotMatch(text, /Destructive \(GSC_ALLOW_DESTRUCTIVE=true\):/);
});

test('get_capabilities at the destructive tier has no not-enabled hints', async () => {
  const text = await capabilities({ ...CLIENT, GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' });
  assert.match(text, /Write \(scope tier write\):/);
  assert.match(text, /Destructive \(GSC_ALLOW_DESTRUCTIVE=true\):\n  - add_site/);
  assert.doesNotMatch(text, /Not enabled at the current tier/);
});

async function reauthenticateText(env: Record<string, unknown>): Promise<string> {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google);
  const server = new McpServer({ name: 't', version: '0' });
  registerAuthInfoTools(server, { config, tokenProvider, gsc: new GscClient({ tokenProvider }) });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  return (await tools.reauthenticate!.executor({}, {})).content[0]!.text;
}

test('reauthenticate describes the configured /auth/google checks', async () => {
  const both = await reauthenticateText({ MCP_AUTH_MODE: 'cf-access,bearer' });
  assert.match(both, /it takes a Cloudflare Access user login \(service tokens are refused\) and the MCP_AUTH_TOKEN\./);
  assert.doesNotMatch(both.split('\n').find((l) => l.startsWith('Only the'))!, / or /);
  assert.match(await reauthenticateText({ MCP_AUTH_MODE: 'cf-access' }), /it takes a Cloudflare Access user login \(service tokens are refused\)\./);
  assert.match(await reauthenticateText({ MCP_AUTH_MODE: 'bearer' }), /it takes the MCP_AUTH_TOKEN\./);
  const withAdmins = await reauthenticateText({ MCP_AUTH_MODE: 'cf-access', GOOGLE_AUTH_ADMINS: 'ops@example.com' });
  assert.match(withAdmins, /it takes a Cloudflare Access login, with one of those identities listed in GOOGLE_AUTH_ADMINS\./);
  assert.doesNotMatch(withAdmins, /ops@example\.com/, 'admin identities are not disclosed to MCP clients');
});
