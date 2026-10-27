/**
 * Seznam Webmaster engine: opt-in registration, per-site key selection,
 * request shape, normalization, 204 handling, error mapping with key
 * redaction, and scope-tier gating. fetch is mocked; nothing leaves the process.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { parseConfig, setEnvSource } from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerCapabilitiesTools } from '../src/tools/capabilities.js';
import { SEZNAM_TOOLS, registerSeznamTools } from '../src/engines/seznam/tools.js';
import { SeznamWebmasterClient, SEZNAM_API_BASE, redactKey } from '../src/engines/seznam/client.js';
import { ENGINE_ENV_PREFIXES } from '../src/lib/config.js';
import { ENGINES } from '../src/engines/registry.js';
import { seznamEngine } from '../src/engines/seznam/index.js';
import { parseSeznamSites, selectSite } from '../src/engines/seznam/sites.js';

const KEY_CZ = 'cz-secret-key-0123456789';
const KEY_SHOP = 'shop-secret-key-9876543210';
const KEYS = JSON.stringify({ 'Example.cz': KEY_CZ, 'https://shop.example.cz/': KEY_SHOP });

interface ToolResult { content: { text: string }[]; isError?: boolean }
interface RegisteredTool { executor: (args: unknown, ctx: unknown) => Promise<ToolResult> }
interface Call { url: URL; method: string; headers: Record<string, string> }

afterEach(() => {
  setEnvSource(process.env as Record<string, unknown>);
});

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

type Responder = (call: Call) => { status?: number; body?: unknown; raw?: string } | undefined;

function harness(env: Record<string, unknown>, respond: Responder) {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google);
  const svc: ServerServices = { config, tokenProvider, gsc: new GscClient({ tokenProvider }) };
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const r = respond(call) ?? { body: {} };
    const status = r.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const server = new McpServer({ name: 't', version: '0' });
  registerSeznamTools(server, svc, { fetchImpl, retryDelayMs: 0 });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = toolsOf(server)[name];
    assert.ok(tool, `${name} is registered`);
    return tool.executor(args, {});
  };
  return { call, calls };
}

const json = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const ALL = SEZNAM_TOOLS.map((t) => t.name);

test('seznam tools are not registered without a key', () => {
  for (const env of [{}, { SEZNAM_API_KEY: '{not json' }, { SEZNAM_API_KEY: '{}' }, { SEZNAM_API_KEY: '  ' }]) {
    setEnvSource(env);
    const names = Object.keys(toolsOf(buildMcpServer()));
    assert.ok(names.includes('list_properties'));
    assert.deepEqual(names.filter((n) => n.startsWith('seznam_')), [], JSON.stringify(env));
  }
});

test('all seznam tools are registered with a JSON or single SEZNAM_API_KEY', () => {
  for (const env of [{ SEZNAM_API_KEY: KEYS }, { SEZNAM_API_KEY: KEY_CZ }]) {
    setEnvSource(env);
    const names = Object.keys(toolsOf(buildMcpServer())).filter((n) => n.startsWith('seznam_'));
    assert.deepEqual(names.sort(), [...ALL].sort());
  }
  assert.equal(ALL.length, 6);
  assert.deepEqual(SEZNAM_TOOLS.filter((t) => t.tier !== 'read').map((t) => [t.name, t.tier]), [['seznam_reindex_url', 'write']]);
});

test('the engine registry wires Seznam in, and SEZNAM_ settings reach config.engineEnv', () => {
  assert.ok(ENGINE_ENV_PREFIXES.includes('SEZNAM_'));
  assert.ok(ENGINES.includes(seznamEngine));
  setEnvSource({ SEZNAM_API_KEY: ` ${KEY_CZ} `, UNRELATED: 'x' });
  const config = parseConfig();
  assert.equal(config.engineEnv.SEZNAM_API_KEY, KEY_CZ);
  assert.equal(config.engineEnv.UNRELATED, undefined);
  assert.equal(seznamEngine.enabled(config), true);
  setEnvSource({ SEZNAM_API_KEY: '{not json' });
  assert.equal(seznamEngine.enabled(parseConfig()), false);
});

test('site map parsing normalizes labels and reports bad entries without keys', () => {
  setEnvSource({ SEZNAM_API_KEY: JSON.stringify({ 'Example.cz/': KEY_CZ, 'bad site/path': 'k', 'empty.cz': '' }) });
  const { sites, error } = parseSeznamSites(parseConfig());
  assert.deepEqual(sites.map((s) => [s.label, s.host, s.protocol]), [['example.cz', 'example.cz', null]]);
  assert.match(error!, /bad site\/path, empty\.cz/);
  assert.doesNotMatch(error!, new RegExp(KEY_CZ));
  setEnvSource({ SEZNAM_API_KEY: ` ${KEY_SHOP} ` });
  assert.deepEqual(parseSeznamSites(parseConfig()).sites.map((s) => [s.label, s.key]), [['default', KEY_SHOP]]);
});

test('key selection by site label, by URL host and protocol, and fallback', () => {
  setEnvSource({ SEZNAM_API_KEY: KEYS });
  const { sites } = parseSeznamSites(parseConfig());
  assert.equal(selectSite(sites, 'example.cz').key, KEY_CZ);
  assert.equal(selectSite(sites, 'https://EXAMPLE.cz/').key, KEY_CZ);
  assert.equal(selectSite(sites, null, 'https://shop.example.cz/item?id=1').key, KEY_SHOP);
  assert.throws(() => selectSite(sites, null, 'http://shop.example.cz/'), /No Seznam API key is configured/);
  assert.throws(() => selectSite(sites, null), /several Seznam sites are configured \(example\.cz, https:\/\/shop\.example\.cz\)/);
  assert.throws(() => selectSite(sites, 'other.cz'), /not configured/);

  setEnvSource({ SEZNAM_API_KEY: 'only' });
  const single = parseSeznamSites(parseConfig()).sites;
  assert.equal(selectSite(single, null).key, 'only');
  assert.equal(selectSite(single, null, 'https://other.cz/').key, 'only');
});

async function capabilitiesText(env: Record<string, unknown>): Promise<string> {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google);
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, { config, tokenProvider, gsc: new GscClient({ tokenProvider }) });
  return (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
}

test('get_capabilities reports Seznam status and site labels, never keys', async () => {
  assert.match(await capabilitiesText({}), /- Seznam Webmaster: not configured \(set the SEZNAM_API_KEY secret to enable seznam_\* tools\)/);
  const on = await capabilitiesText({ SEZNAM_API_KEY: KEYS });
  assert.match(on, /- Seznam Webmaster: enabled/);
  assert.match(on, /Sites with a key: example\.cz, https:\/\/shop\.example\.cz\./);
  assert.match(on, /- seznam_get_documents \[read\]: /);
  assert.match(on, /- seznam_reindex_url \[write\]: .*\(not enabled at the current tier: needs TOOL_TIER=write\)/);
  assert.doesNotMatch(on, new RegExp(`${KEY_CZ}|${KEY_SHOP}`));
  const partial = await capabilitiesText({ SEZNAM_API_KEY: JSON.stringify({ 'example.cz': KEY_CZ, 'bad site/path': 'k' }), TOOL_TIER: 'write' });
  assert.match(partial, /Warning: SEZNAM_API_KEY: ignored entries[^\n]*bad site\/path/);
  assert.doesNotMatch(partial, /seznam_reindex_url \[write\]: .*not enabled/);
});

test('seznam_list_sites lists labels only', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEYS }, () => undefined);
  const r = await call('seznam_list_sites', {});
  assert.deepEqual((json(r).sites as unknown[]), [{ site: 'example.cz' }, { site: 'https://shop.example.cz' }]);
  assert.doesNotMatch(r.content[0]!.text, new RegExp(`${KEY_CZ}|${KEY_SHOP}`));
  assert.equal(calls.length, 0);
});

test('requests use the site key as the key query parameter', async () => {
  const docs = {
    doc_count: { count: 50, urls: [] },
    content: { count: 40, urls: ['https://example.cz/a', 'https://example.cz/b', 'https://example.cz/c'] },
    index: { count: 30, urls: ['https://example.cz/a'] },
    redirect: { count: 1, urls: ['https://example.cz/r'] },
    error: { count: 2, urls: ['https://example.cz/x', 'https://example.cz/y'] },
  };
  const { call, calls } = harness({ SEZNAM_API_KEY: KEYS }, () => ({ body: docs }));
  const r = await call('seznam_get_documents', { site: 'example.cz', categories: ['error', 'content'], url_limit: 2 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(json(r), {
    site: 'example.cz',
    data_available: true,
    documents: {
      content: { count: 40, urls_returned: 2, urls_total_in_sample: 3, urls: ['https://example.cz/a', 'https://example.cz/b'] },
      error: { count: 2, urls_returned: 2, urls_total_in_sample: 2, urls: ['https://example.cz/x', 'https://example.cz/y'] },
    },
  });
  const c = calls[0]!;
  assert.equal(`${c.url.origin}${c.url.pathname}`, `${SEZNAM_API_BASE}/web/documents`);
  assert.equal(c.url.searchParams.get('key'), KEY_CZ);
  assert.equal(c.method, 'GET');
  assert.equal(c.headers.Accept, 'application/json');
});

test('seznam_get_site normalizes documents and history', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEY_CZ }, () => ({
    body: {
      webserver: 'cz.example.!443',
      documents: { index: { count: 3, urls: ['https://example.cz/1', 'https://example.cz/2'] } },
      history: [{ date: '2026-10-18', counts: { error: 1, downloaded: 10, redirected: 0, indexed: 3, doc_count: 10, content: 9 } }],
    },
  }));
  const r = json(await call('seznam_get_site', { url_limit: 1 }));
  assert.deepEqual(r, {
    site: 'default',
    data_available: true,
    webserver: 'cz.example.!443',
    documents: { index: { count: 3, urls_returned: 1, urls_total_in_sample: 2, urls: ['https://example.cz/1'] } },
    history: [{ date: '2026-10-18', counts: { error: 1, downloaded: 10, redirected: 0, indexed: 3, doc_count: 10, content: 9 } }],
  });
  assert.equal(calls[0]!.url.pathname, '/wm-api/web');
});

test('history validates dates and passes them through', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEY_CZ }, () => ({ body: [{ date: '2026-10-01', counts: { indexed: 5 } }] }));
  const bad = await call('seznam_get_documents_history', { date_from: '2026-13-01' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /date_from must be a date in YYYY-MM-DD format/);
  const reversed = await call('seznam_get_documents_history', { date_from: '2026-10-02', date_to: '2026-10-01' });
  assert.equal(reversed.isError, true);
  assert.equal(calls.length, 0);
  const ok = json(await call('seznam_get_documents_history', { date_from: '2026-10-01', date_to: null }));
  assert.deepEqual(ok.history, [{ date: '2026-10-01', counts: { indexed: 5 } }]);
  assert.equal(calls[0]!.url.pathname, '/wm-api/web/documents-history');
  assert.equal(calls[0]!.url.searchParams.get('date_from'), '2026-10-01');
  assert.equal(calls[0]!.url.searchParams.has('date_to'), false);
});

test('seznam_get_document picks the key from the URL and normalizes the page', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEYS }, () => ({
    body: {
      url: 'https://shop.example.cz/p', title: 'P', indexTimestamp: 1760000000, downloadTimestamp: 1760000100,
      isIndexed: true, isError: false, isRedirect: false, meta: { author: '', desc: 'd', keywords: '' },
      openGraphData: [{ name: 'og:title', content: 'P' }],
      responseHeaders: [{ name: 'content-type', value: 'text/html' }, { name: 'server', content: 'nginx' }],
    },
  }));
  const r = json(await call('seznam_get_document', { url: 'https://shop.example.cz/p' }));
  assert.equal(r.site, 'https://shop.example.cz');
  assert.equal(r.is_indexed, true);
  assert.equal(r.index_timestamp, 1760000000);
  assert.deepEqual(r.response_headers, [{ name: 'content-type', value: 'text/html' }, { name: 'server', value: 'nginx' }]);
  assert.equal(calls[0]!.url.searchParams.get('key'), KEY_SHOP);
  assert.equal(calls[0]!.url.searchParams.get('url'), 'https://shop.example.cz/p');
});

test('204 means data not available yet, not an error', async () => {
  const { call } = harness({ SEZNAM_API_KEY: KEY_CZ }, () => ({ status: 204 }));
  const r = await call('seznam_get_site', {});
  assert.equal(r.isError, undefined);
  assert.equal(json(r).data_available, false);
  assert.match(String(json(r).message), /not available yet.*24 hours/);
});

test('401, 404, 429 and 503 errors are explained and never leak the key', async () => {
  const echo = (status: number) => ({ status, raw: JSON.stringify({ title: 'Problem', detail: `bad request to /wm-api/web?key=${KEY_CZ}&x=1 (${KEY_CZ})`, status }) });
  for (const [status, pattern] of [
    [401, /rejected the API key \(site example\.cz\) \(HTTP 401\).*reporter\.seznam\.cz\/wm\/.*wrangler secret put SEZNAM_API_KEY/],
    [404, /found no data for the site or page \(HTTP 404\)/],
    [429, /rate limit.*5 requests per second and 100 per minute.*500 times a day/],
    [503, /unavailable \(HTTP 503\)/],
  ] as const) {
    const { call, calls } = harness({ SEZNAM_API_KEY: JSON.stringify({ 'example.cz': KEY_CZ }) }, () => echo(status));
    const r = await call('seznam_get_documents', {});
    assert.equal(r.isError, true, String(status));
    assert.match(r.content[0]!.text, pattern);
    assert.doesNotMatch(r.content[0]!.text, new RegExp(KEY_CZ));
    if (status === 401 || status === 404) assert.equal(calls.length, 1, 'not retried');
    if (status === 429 || status === 503) assert.equal(calls.length, 3, 'retried twice');
  }
});

test('reindex is gated at the read tier and calls nothing', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEY_CZ }, () => undefined);
  const r = await call('seznam_reindex_url', { url: 'https://example.cz/p' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Safety: seznam_reindex_url changes data in Seznam Webmaster and is disabled at the current tool tier \(read\)[\s\S]*needs write rights/);
  assert.equal(calls.length, 0);
});

test('reindex at the write tier POSTs key and url as query parameters', async () => {
  const { call, calls } = harness({ SEZNAM_API_KEY: KEYS, TOOL_TIER: 'write' }, () => ({ raw: '' }));
  const r = await call('seznam_reindex_url', { url: 'https://example.cz/new' });
  assert.deepEqual(json(r), { site: 'example.cz', requested: true, url: 'https://example.cz/new' });
  const c = calls[0]!;
  assert.equal(c.method, 'POST');
  assert.equal(c.url.pathname, '/wm-api/web/document/reindex');
  assert.equal(c.url.searchParams.get('key'), KEY_CZ);
  assert.equal(c.url.searchParams.get('url'), 'https://example.cz/new');
});

test('reindex 403 explains that the key needs write rights', async () => {
  const { call } = harness({ SEZNAM_API_KEY: KEY_CZ, TOOL_TIER: 'write' }, () => ({ status: 403, body: { title: 'Forbidden', status: 403 } }));
  const r = await call('seznam_reindex_url', { url: 'https://example.cz/p' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /needs a key with write rights/);
});

test('network errors are redacted', async () => {
  const client = new SeznamWebmasterClient({
    maxAttempts: 1,
    fetchImpl: (async (input: unknown) => { throw new Error(`getaddrinfo failed for ${String(input)}`); }) as typeof fetch,
  });
  await assert.rejects(client.request('/web', KEY_CZ), (e: Error) => !e.message.includes(KEY_CZ) && /key=REDACTED/.test(e.message));
  assert.equal(redactKey(`x ${KEY_CZ} y`, KEY_CZ), 'x REDACTED y');
});
