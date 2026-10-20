/**
 * Yandex Webmaster engine: opt-in registration, request shape, response
 * normalization, error mapping, and scope-tier gating. fetch is mocked; no
 * call leaves the process.
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
import { YANDEX_TOOLS, registerYandexTools } from '../src/engines/yandex/tools.js';
import { ENGINE_ENV_PREFIXES } from '../src/lib/config.js';
import { ENGINES } from '../src/engines/registry.js';
import { yandexEngine, yandexToken } from '../src/engines/yandex/index.js';
import { YandexWebmasterClient, normalizeYandexDate, YANDEX_API_BASE } from '../src/engines/yandex/client.js';

const TOKEN = 'y0_secret-yandex-token-value';
const HOST_ID = 'https:example.com:443';

interface ToolResult { content: { text: string }[]; isError?: boolean }
interface RegisteredTool { executor: (args: unknown, ctx: unknown) => Promise<ToolResult> }
interface Call { url: URL; method: string; headers: Record<string, string>; body?: unknown }

afterEach(() => {
  setEnvSource(process.env as Record<string, unknown>);
});

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

type Responder = (call: Call) => { status?: number; body?: unknown } | undefined;

function harness(env: Record<string, unknown>, respond: Responder) {
  setEnvSource({ YANDEX_OAUTH_TOKEN: TOKEN, ...env });
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google);
  const svc: ServerServices = { config, tokenProvider, gsc: new GscClient({ tokenProvider }) };
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const path = call.url.pathname;
    if (path === '/v4/user') return Response.json({ user_id: 42 });
    if (path === '/v4/user/42/hosts' && call.method === 'GET') {
      return Response.json({ hosts: [{ host_id: HOST_ID, ascii_host_url: 'https://example.com/', unicode_host_url: 'https://example.com/', verified: true, main_mirror: null }] });
    }
    const r = respond(call) ?? { body: {} };
    const status = r.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(r.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const server = new McpServer({ name: 't', version: '0' });
  registerYandexTools(server, svc, { token: TOKEN, fetchImpl, retryDelayMs: 0 });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = toolsOf(server)[name];
    assert.ok(tool, `${name} is registered`);
    return tool.executor(args, {});
  };
  return { call, calls, server };
}

function json(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const ALL_TOOLS = YANDEX_TOOLS.map((t) => t.name);

test('yandex tools are not registered when YANDEX_OAUTH_TOKEN is unset', () => {
  setEnvSource({});
  const names = Object.keys(toolsOf(buildMcpServer()));
  assert.ok(names.includes('list_properties'));
  assert.deepEqual(names.filter((n) => n.startsWith('yandex_')), []);
});

test('all yandex tools are registered when YANDEX_OAUTH_TOKEN is set', () => {
  setEnvSource({ YANDEX_OAUTH_TOKEN: TOKEN });
  const names = Object.keys(toolsOf(buildMcpServer())).filter((n) => n.startsWith('yandex_'));
  assert.deepEqual(names.sort(), [...ALL_TOOLS].sort());
  assert.equal(ALL_TOOLS.length, 27);
  const byTier = (tier: string) => YANDEX_TOOLS.filter((t) => t.tier === tier).map((t) => t.name);
  assert.deepEqual(byTier('write'), ['yandex_add_sitemap', 'yandex_recrawl_url']);
  assert.deepEqual(byTier('destructive'), ['yandex_delete_sitemap']);
});

test('the engine registry wires Yandex in, and YANDEX_ settings reach config.engineEnv', () => {
  assert.ok(ENGINE_ENV_PREFIXES.includes('YANDEX_'));
  assert.ok(ENGINES.includes(yandexEngine));
  setEnvSource({ YANDEX_OAUTH_TOKEN: ` ${TOKEN} `, UNRELATED: 'x' });
  const config = parseConfig();
  assert.equal(yandexToken(config), TOKEN);
  assert.equal(config.engineEnv.UNRELATED, undefined);
});

test('a blank YANDEX_OAUTH_TOKEN counts as unset', () => {
  setEnvSource({ YANDEX_OAUTH_TOKEN: '   ' });
  const config = parseConfig();
  assert.equal(yandexToken(config), undefined);
  assert.equal(yandexEngine.enabled(config), false);
});

async function capabilitiesText(env: Record<string, unknown>): Promise<string> {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google);
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, { config, tokenProvider, gsc: new GscClient({ tokenProvider }) });
  return (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
}

test('get_capabilities reports whether Yandex is enabled without revealing the token', async () => {
  assert.match(await capabilitiesText({}), /- Yandex Webmaster: not configured \(set the YANDEX_OAUTH_TOKEN secret to enable yandex_\* tools\)/);
  const on = await capabilitiesText({ YANDEX_OAUTH_TOKEN: TOKEN });
  assert.match(on, /- Yandex Webmaster: enabled \(YANDEX_OAUTH_TOKEN is set\)/);
  assert.match(on, /about 6 months/);
  assert.match(on, /- yandex_list_hosts \[read\]: /);
  assert.match(on, /- yandex_recrawl_url \[write\]: .*\(not enabled at the current tier: needs GSC_SCOPES=full\)/);
  assert.doesNotMatch(on, new RegExp(TOKEN));
  const full = await capabilitiesText({ YANDEX_OAUTH_TOKEN: TOKEN, GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' });
  assert.match(full, /- yandex_delete_sitemap \[destructive\]: /);
  assert.doesNotMatch(full, /yandex_delete_sitemap \[destructive\]: .*not enabled/);
});

test('requests carry the OAuth header, resolve user_id once, and repeat multi-value parameters', async () => {
  const { call, calls } = harness({}, (c) => {
    if (c.url.pathname.endsWith('/search-queries/popular')) {
      return { body: { queries: [{ query_id: 'a08b', query_text: 'some text', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 2 } }], date_from: '2026-10-01', date_to: '2026-10-07', count: '300' } };
    }
    return { body: { sqi: 5, searchable_pages_count: 100, excluded_pages_count: 3, site_problems: { FATAL: 0 } } };
  });
  const popular = await call('yandex_get_popular_queries', {
    host: HOST_ID,
    order_by: 'TOTAL_CLICKS',
    query_indicators: ['TOTAL_SHOWS', 'TOTAL_CLICKS'],
    device_type: 'MOBILE',
    date_from: '2026-10-01',
    date_to: null,
    limit: 10,
  });
  assert.equal(popular.isError, undefined);
  assert.deepEqual(json(popular), {
    date_from: '2026-10-01',
    date_to: '2026-10-07',
    total_count: 300,
    queries: [{ query_id: 'a08b', query_text: 'some text', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 2 } }],
  });
  await call('yandex_get_host_summary', { host: HOST_ID });

  assert.equal(calls.filter((c) => c.url.pathname === '/v4/user').length, 1, 'user_id is cached per server instance');
  for (const c of calls) {
    assert.equal(c.url.origin + '/v4', YANDEX_API_BASE);
    assert.equal(c.headers.Authorization, `OAuth ${TOKEN}`);
    assert.equal(c.headers.Accept, 'application/json');
  }
  const q = calls.find((c) => c.url.pathname.endsWith('/search-queries/popular'))!;
  assert.equal(q.url.pathname, '/v4/user/42/hosts/https:example.com:443/search-queries/popular');
  assert.equal(q.url.searchParams.get('order_by'), 'TOTAL_CLICKS');
  assert.deepEqual(q.url.searchParams.getAll('query_indicator'), ['TOTAL_SHOWS', 'TOTAL_CLICKS']);
  assert.equal(q.url.searchParams.get('device_type_indicator'), 'MOBILE');
  assert.equal(q.url.searchParams.get('date_from'), '2026-10-01');
  assert.equal(q.url.searchParams.has('date_to'), false, 'explicit null is omitted');
  assert.equal(q.url.searchParams.has('offset'), false);
  assert.equal(q.url.searchParams.get('limit'), '10');
  assert.equal(calls.at(-1)!.url.pathname, '/v4/user/42/hosts/https:example.com:443/summary');
});

test('a site URL is resolved to its host_id through the host list', async () => {
  const { call, calls } = harness({}, () => ({ body: { daily_quota: 20, quota_remainder: 19 } }));
  const r = await call('yandex_get_recrawl_quota', { host: 'https://EXAMPLE.com' });
  assert.deepEqual(json(r), { daily_quota: 20, quota_remainder: 19 });
  assert.equal(calls.at(-1)!.url.pathname, '/v4/user/42/hosts/https:example.com:443/recrawl/quota');

  const missing = await call('yandex_get_recrawl_quota', { host: 'https://other.example/' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /not in this Yandex Webmaster account.*Known sites: https:\/\/example\.com\//);
  assert.equal(calls.filter((c) => c.url.pathname === '/v4/user/42/hosts').length, 1, 'host list is cached');
});

test('history and sample responses are normalized to ISO dates', async () => {
  const { call } = harness({}, (c) => {
    const p = c.url.pathname;
    if (p.endsWith('/indexing/history')) return { body: { indicators: { HTTP_2XX: [{ date: '2016-01-01T00:00:00,000+0300', value: 7 }] } } };
    if (p.endsWith('/search-urls/in-search/history')) return { body: { history: [{ date: '2016-01-02T00:00:00,000+0300', value: 9 }] } };
    if (p.endsWith('/search-urls/events/samples')) {
      return { body: { count: 1, samples: [{ url: 'https://example.com/a', title: 't', event_date: '2016-01-03T00:00:00,000+0300', last_access: '2016-01-01T00:00:00,000+0300', event: 'REMOVED_FROM_SEARCH', excluded_url_status: 'DUPLICATE', target_url: 'https://example.com/b' }] } };
    }
    if (p.endsWith('/search-queries/q1/history')) {
      return { body: { queries: [{ query_id: 'q1', query_text: 'shoes', indicators: { TOTAL_CLICKS: [{ date: '2019-07-18T00:00:00.000+03:00', value: 2.0 }] } }] } };
    }
    return undefined;
  });
  const indexing = json(await call('yandex_get_indexing_history', { host: HOST_ID, date_from: '2016-01-01', date_to: '2016-01-31' }));
  assert.deepEqual(indexing, { indicators: { HTTP_2XX: [{ date: '2016-01-01T00:00:00.000+03:00', value: 7 }] } });
  assert.deepEqual(json(await call('yandex_get_in_search_history', { host: HOST_ID })), { history: [{ date: '2016-01-02T00:00:00.000+03:00', value: 9 }] });
  const events = json(await call('yandex_get_search_events_samples', { host: HOST_ID, offset: 0, limit: 1 })) as { samples: Record<string, unknown>[] };
  assert.equal(events.samples[0]!.event_date, '2016-01-03T00:00:00.000+03:00');
  assert.equal(events.samples[0]!.excluded_url_status, 'DUPLICATE');
  const query = json(await call('yandex_get_query_history', { host: HOST_ID, query_id: 'q1', query_indicators: ['TOTAL_CLICKS'] }));
  assert.deepEqual(query, { query_id: 'q1', query_text: 'shoes', indicators: { TOTAL_CLICKS: [{ date: '2019-07-18T00:00:00.000+03:00', value: 2 }] } });
});

test('diagnostics list present problems first, by severity', async () => {
  const { call } = harness({}, () => ({
    body: {
      problems: {
        NO_REGIONS: { severity: 'RECOMMENDATION', state: 'PRESENT', last_state_update: '2016-01-01T00:00:00,000+0300' },
        DNS_ERROR: { severity: 'FATAL', state: 'ABSENT', last_state_update: '2016-01-01T00:00:00,000+0300' },
        SSL_CERTIFICATE_ERROR: { severity: 'CRITICAL', state: 'PRESENT', last_state_update: '2016-01-01T00:00:00,000+0300' },
      },
    },
  }));
  const all = json(await call('yandex_get_diagnostics', { host: HOST_ID })) as { present_count: number; problems: { type: string }[] };
  assert.equal(all.present_count, 2);
  assert.deepEqual(all.problems.map((p) => p.type), ['SSL_CERTIFICATE_ERROR', 'NO_REGIONS', 'DNS_ERROR']);
  const present = json(await call('yandex_get_diagnostics', { host: HOST_ID, only_present: true })) as { problems: unknown[] };
  assert.equal(present.problems.length, 2);
});

test('external link history always sends the required indicator', async () => {
  const { call, calls } = harness({}, () => ({ body: { indicators: { LINKS_TOTAL_COUNT: [{ date: '2019-01-01T00:00:00,000+0300', value: 1 }] } } }));
  await call('yandex_get_external_links_history', { host: HOST_ID });
  assert.equal(calls.at(-1)!.url.searchParams.get('indicator'), 'LINKS_TOTAL_COUNT');
  await call('yandex_get_broken_internal_links', { host: HOST_ID, indicators: ['SITE_ERROR', 'DISALLOWED_BY_USER'] });
  assert.deepEqual(calls.at(-1)!.url.searchParams.getAll('indicator'), ['SITE_ERROR', 'DISALLOWED_BY_USER']);
  assert.equal(calls.at(-1)!.url.pathname, '/v4/user/42/hosts/https:example.com:443/links/internal/broken/samples');
});

test('429 reports the daily quota and reset time and is not retried', async () => {
  const { call, calls } = harness({ GSC_SCOPES: 'full' }, (c) =>
    c.url.pathname.endsWith('/recrawl/queue')
      ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', daily_quota: 20, exceeded_until: '2026-10-21T00:00:00,000+0300', error_message: 'quota' } }
      : undefined);
  const r = await call('yandex_recrawl_url', { host: HOST_ID, url: 'https://example.com/page' });
  assert.equal(r.isError, true);
  const text = r.content[0]!.text;
  assert.match(text, /quota exceeded/i);
  assert.match(text, /QUOTA_EXCEEDED/);
  assert.match(text, /Daily quota: 20/);
  assert.match(text, /2026-10-21T00:00:00\.000\+03:00/);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/recrawl/queue')).length, 1);
});

test('401/INVALID_OAUTH_TOKEN explains how to renew the token and never echoes it', async () => {
  for (const status of [401, 403]) {
    const { call } = harness({}, () => ({ status, body: { error_code: 'INVALID_OAUTH_TOKEN', error_message: 'bad token' } }));
    const r = await call('yandex_get_host', { host: HOST_ID });
    assert.equal(r.isError, true);
    const text = r.content[0]!.text;
    assert.match(text, /Yandex rejected YANDEX_OAUTH_TOKEN/);
    assert.match(text, /https:\/\/oauth\.yandex\.com\/authorize\?response_type=token&client_id=/);
    assert.match(text, /wrangler secret put YANDEX_OAUTH_TOKEN/);
    assert.match(text, /6 months/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
  }
  const { call } = harness({}, () => ({ status: 403, body: { error_code: 'ACCESS_FORBIDDEN', error_message: 'nope' } }));
  assert.match((await call('yandex_get_host', { host: HOST_ID })).content[0]!.text, /HTTP 403 ACCESS_FORBIDDEN.*webmaster:hostinfo/);
});

test('404 errors keep the Yandex error code', async () => {
  const { call } = harness({}, () => ({ status: 404, body: { error_code: 'HOST_NOT_VERIFIED', host_id: HOST_ID, error_message: 'not verified' } }));
  const r = await call('yandex_get_sqi_history', { host: HOST_ID });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /not verified \(HTTP 404 HOST_NOT_VERIFIED\)/);
});

test('5xx is retried, then succeeds', async () => {
  let failures = 0;
  const calls: string[] = [];
  const client = new YandexWebmasterClient({
    token: TOKEN,
    retryDelayMs: 0,
    fetchImpl: (async (input: unknown) => {
      calls.push(String(input));
      if (failures++ < 2) return new Response('{}', { status: 503 });
      return Response.json({ user_id: 7 });
    }) as typeof fetch,
  });
  assert.equal(await client.userId(), 7);
  assert.equal(calls.length, 3);
});

test('a failed user_id lookup is not cached', async () => {
  let n = 0;
  const client = new YandexWebmasterClient({
    token: TOKEN,
    fetchImpl: (async () => (n++ === 0 ? Response.json({ error_code: 'INVALID_OAUTH_TOKEN', error_message: 'x' }, { status: 401 }) : Response.json({ user_id: 9 }))) as typeof fetch,
  });
  await assert.rejects(client.userId(), /x/);
  assert.equal(await client.userId(), 9);
});

test('write tools are gated at the read tier and call nothing', async () => {
  const { call, calls } = harness({}, () => undefined);
  for (const [name, args] of [
    ['yandex_recrawl_url', { host: HOST_ID, url: 'https://example.com/p' }],
    ['yandex_add_sitemap', { host: HOST_ID, sitemap_url: 'https://example.com/sitemap.xml' }],
    ['yandex_delete_sitemap', { host: HOST_ID, sitemap_id: 'c7-fe:80-c0' }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0]!.text, new RegExp(`Safety: ${name} (changes data in|removes data from) Yandex Webmaster and is disabled at the current scope tier \\(read\\)`));
  }
  assert.equal(calls.length, 0);
});

test('write tier allows recrawl and add-sitemap with the documented JSON bodies, but not delete', async () => {
  const { call, calls } = harness({ GSC_SCOPES: 'full' }, (c) => {
    if (c.url.pathname.endsWith('/recrawl/queue')) return { status: 202, body: { task_id: 'c7fe80c0-36e3-11e6-8b2d-df96aa592c0a', quota_remainder: 19 } };
    if (c.url.pathname.endsWith('/user-added-sitemaps')) return { status: 201, body: { sitemap_id: 'c7-fe:80-c0' } };
    return undefined;
  });
  const recrawl = await call('yandex_recrawl_url', { host: HOST_ID, url: 'https://example.com/p' });
  assert.deepEqual(json(recrawl), { queued: true, url: 'https://example.com/p', task_id: 'c7fe80c0-36e3-11e6-8b2d-df96aa592c0a', quota_remainder: 19 });
  const post = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/recrawl/queue'))!;
  assert.deepEqual(post.body, { url: 'https://example.com/p' });
  assert.equal(post.headers['Content-Type'], 'application/json');

  const added = await call('yandex_add_sitemap', { host: HOST_ID, sitemap_url: 'https://example.com/sitemap.xml' });
  assert.deepEqual(json(added), { added: true, sitemap_url: 'https://example.com/sitemap.xml', sitemap_id: 'c7-fe:80-c0' });
  assert.deepEqual(calls.at(-1)!.body, { url: 'https://example.com/sitemap.xml' });

  const del = await call('yandex_delete_sitemap', { host: HOST_ID, sitemap_id: 'c7-fe:80-c0' });
  assert.equal(del.isError, true);
  assert.match(del.content[0]!.text, /GSC_ALLOW_DESTRUCTIVE=true/);
  assert.equal(calls.some((c) => c.method === 'DELETE'), false);
});

test('destructive tier deletes a user-added sitemap (204)', async () => {
  const { call, calls } = harness({ GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' }, () => ({ status: 204 }));
  const r = await call('yandex_delete_sitemap', { host: HOST_ID, sitemap_id: 'c7-fe:80-c0' });
  assert.deepEqual(json(r), { deleted: true, sitemap_id: 'c7-fe:80-c0' });
  const del = calls.at(-1)!;
  assert.equal(del.method, 'DELETE');
  assert.equal(del.url.pathname, '/v4/user/42/hosts/https:example.com:443/user-added-sitemaps/c7-fe:80-c0');
});

test('sitemap listing is normalized', async () => {
  const { call, calls } = harness({}, () => ({
    body: { sitemaps: [{ sitemap_id: 'c7-fe:80-c0', sitemap_url: 'https://example.com/sitemap.xml', last_access_date: '2016-01-01T00:00:00,000+0300', errors_count: 1, urls_count: 10, children_count: 0, sources: ['ROBOTS_TXT'], sitemap_type: 'SITEMAP' }] },
  }));
  const r = json(await call('yandex_list_sitemaps', { host: HOST_ID, limit: 100, from: null, parent_id: null }));
  assert.deepEqual(r, {
    count: 1,
    sitemaps: [{ sitemap_id: 'c7-fe:80-c0', sitemap_url: 'https://example.com/sitemap.xml', sitemap_type: 'SITEMAP', last_access_date: '2016-01-01T00:00:00.000+03:00', urls_count: 10, errors_count: 1, children_count: 0, sources: ['ROBOTS_TXT'] }],
  });
  assert.equal(calls.at(-1)!.url.search, '?limit=100');
});

test('normalizeYandexDate', () => {
  assert.equal(normalizeYandexDate('2016-01-01T00:00:00,000+0300'), '2016-01-01T00:00:00.000+03:00');
  assert.equal(normalizeYandexDate('2019-07-18T00:00:00.000+03:00'), '2019-07-18T00:00:00.000+03:00');
  assert.equal(normalizeYandexDate('2019-01-01'), '2019-01-01');
  assert.equal(normalizeYandexDate('garbage'), 'garbage');
  assert.equal(normalizeYandexDate(undefined), null);
});
