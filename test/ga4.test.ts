/**
 * Google Analytics 4 engine: opt-in registration, OAuth scope, REST client
 * shape, granted-scope gating, and capability copy. fetch is mocked.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import {
  GOOGLE_SCOPE_ANALYTICS,
  GOOGLE_SCOPE_ANALYTICS_READONLY,
  GOOGLE_SCOPE_FULL,
  GOOGLE_SCOPE_READONLY,
  parseConfig,
  setEnvSource,
} from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import { hasAnalyticsReadScope, scopesCover } from '../src/lib/google-oauth/google.js';
import { GoogleTokenStore } from '../src/lib/google-oauth/store.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerCapabilitiesTools } from '../src/tools/capabilities.js';
import { buildApp } from '../src/app.js';
import { ENGINES } from '../src/engines/registry.js';
import { ga4Engine } from '../src/engines/ga4/index.js';
import { GA4_TOOLS, registerGa4Tools } from '../src/engines/ga4/tools.js';
import { Ga4ApiError, Ga4Client, propertyResourceName, toRestJson } from '../src/engines/ga4/client.js';
import { MemoryKv } from './helpers/memory-kv.js';

const KEY = randomBytes(32).toString('base64');
const CLIENT = 'cid.apps.googleusercontent.com';
const HOST = 'gsc.example.com';
const TOKEN = 'b'.repeat(48);
const realFetch = globalThis.fetch;

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  executor: (args: unknown, ctx: unknown) => Promise<ToolResult>;
}
const toolsOf = (server: McpServer) =>
  (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

afterEach(() => {
  globalThis.fetch = realFetch;
  setEnvSource(process.env as Record<string, unknown>);
});

interface Call {
  url: URL;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function withAccounts(
  granted: Record<string, string | null>,
  respond: (call: Call) => Response | Promise<Response>,
): Promise<{ run: (name: string, args: unknown) => Promise<ToolResult>; calls: Call[] }> {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
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
  setEnvSource({
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'sec',
  });
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google, tokenFetch, { store });
  const { calls, fetchImpl } = mockFetch(respond);
  const svc: ServerServices = {
    config,
    tokenProvider,
    gsc: new GscClient({ tokenProvider }),
    tokenStore: store,
  };
  const server = new McpServer({ name: 't', version: '0' });
  const client = new Ga4Client({ tokenProvider, fetchImpl, sleep: async () => undefined });
  registerGa4Tools(server, svc, client);
  const run = (name: string, args: unknown) => toolsOf(server)[name]!.executor(args, {});
  return { run, calls };
}

// ---------- helpers ----------

test('propertyResourceName accepts numbers, digit strings, and properties/N', () => {
  assert.equal(propertyResourceName(123), 'properties/123');
  assert.equal(propertyResourceName('123'), 'properties/123');
  assert.equal(propertyResourceName('properties/123'), 'properties/123');
  assert.throws(() => propertyResourceName('sc-domain:example.com'), /Invalid property ID/);
  assert.throws(() => propertyResourceName('properties/abc'), /Invalid property ID/);
});

test('toRestJson converts snake_case keys and leaves camelCase and values alone', () => {
  assert.deepEqual(
    toRestJson({
      start_date: 'today',
      dimension_filter: { filter: { field_name: 'eventName', string_filter: { match_type: 'EXACT', value: 'page_view' } } },
      alreadyCamel: true,
    }),
    {
      startDate: 'today',
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'page_view' } } },
      alreadyCamel: true,
    },
  );
});

test('hasAnalyticsReadScope and scopesCover treat analytics as covering readonly', () => {
  assert.equal(hasAnalyticsReadScope(GOOGLE_SCOPE_ANALYTICS_READONLY), true);
  assert.equal(hasAnalyticsReadScope(GOOGLE_SCOPE_ANALYTICS), true);
  assert.equal(hasAnalyticsReadScope(GOOGLE_SCOPE_READONLY), false);
  assert.equal(scopesCover(GOOGLE_SCOPE_ANALYTICS, [GOOGLE_SCOPE_ANALYTICS_READONLY]), true);
  assert.equal(scopesCover(GOOGLE_SCOPE_READONLY, [GOOGLE_SCOPE_ANALYTICS_READONLY]), false);
});

test('default Google scopes never include analytics (a leftover GA4_ENABLED is ignored)', () => {
  setEnvSource({});
  assert.deepEqual(parseConfig().google.scopes, [GOOGLE_SCOPE_READONLY]);
  setEnvSource({ GA4_ENABLED: 'true', GSC_SCOPES: 'full' });
  assert.deepEqual(parseConfig().google.scopes, [GOOGLE_SCOPE_FULL]);
});

// ---------- registration ----------

test('ga4 tools are registered without any configuration', () => {
  setEnvSource({});
  const names = Object.keys(toolsOf(buildMcpServer())).filter((n) => n.startsWith('ga4_')).sort();
  assert.deepEqual(names, GA4_TOOLS.map((t) => t.name).sort());
  assert.ok(ENGINES.includes(ga4Engine));
});

test('get_capabilities reports GA4 status, boundary, and re-consent without secrets', async () => {
  setEnvSource({});
  const off = parseConfig();
  const tokenProvider = new TokenProvider(off.google, (async () => new Response('{}', { status: 500 })) as typeof fetch);
  const offServer = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(offServer, { config: off, tokenProvider, gsc: new GscClient({ tokenProvider }) });
  const offText = (await toolsOf(offServer).get_capabilities!.executor({}, {})).content[0]!.text;
  assert.match(offText, /Google Analytics 4: enabled\n/);
  assert.match(offText, /\/auth\/google\?ga4=1/);
  assert.match(offText, /ga4_run_report \[read\]/);
  assert.doesNotMatch(offText, /GA4_ENABLED/);

  const { run } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    () => json({}),
  );
  const capServer = new McpServer({ name: 't', version: '0' });
  setEnvSource({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'sec' });
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', {
    scope: `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
    grantedScope: `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
    clientId: CLIENT,
    email: 'ada@example.com',
  });
  const cfg = parseConfig();
  const tp = new TokenProvider(cfg.google, (async () => Response.json({ access_token: 'at', expires_in: 3600 })) as typeof fetch, { store });
  registerCapabilitiesTools(capServer, { config: cfg, tokenProvider: tp, gsc: new GscClient({ tokenProvider: tp }), tokenStore: store });
  const onText = (await toolsOf(capServer).get_capabilities!.executor({}, {})).content[0]!.text;
  assert.match(onText, /Google Analytics 4: enabled\n/);
  assert.match(onText, /ga4_run_report \[read\]/);
  assert.match(onText, /ga4_run_funnel_report \[read\]/);
  assert.match(onText, /Capability boundary/);
  assert.match(onText, /Create-annotation and other Admin writes stay off/);
  assert.match(onText, /ada@example\.com.*granted scope readonly, analytics/);
  assert.match(onText, /not analytics\.edit/);
  assert.doesNotMatch(onText, /rt-ada/);
  void run;
});

test('get_capabilities marks a Search Console-only grant as no analytics, without a warning', async () => {
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', {
    scope: GOOGLE_SCOPE_READONLY,
    grantedScope: GOOGLE_SCOPE_READONLY,
    clientId: CLIENT,
    email: 'ada@example.com',
  });
  setEnvSource({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'sec' });
  const cfg = parseConfig();
  const tp = new TokenProvider(cfg.google, undefined, { store });
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, { config: cfg, tokenProvider: tp, gsc: new GscClient({ tokenProvider: tp }), tokenStore: store });
  const text = (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
  assert.doesNotMatch(text, /does not include analytics/);
  assert.match(text, /granted scope readonly, no analytics/);
  assert.doesNotMatch(text, /does not cover the configured GSC_SCOPES/);
});

// ---------- OAuth ----------

test('start requests analytics.readonly only with ?ga4=1, and always keeps granted scopes', async () => {
  function setup(env: Record<string, unknown> = {}) {
    const kv = new MemoryKv();
    setEnvSource({
      MCP_AUTH_MODE: 'bearer',
      MCP_AUTH_TOKEN: TOKEN,
      MCP_ALLOWED_HOSTS: HOST,
      GOOGLE_CLIENT_ID: CLIENT,
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GSC_TOKENS: kv,
      TOKEN_ENCRYPTION_KEY: KEY,
      ...env,
    });
    const app = buildApp('worker');
    const call = (path: string) =>
      app.request(`https://${HOST}${path}`, { headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    return { call, kv };
  }
  const off = setup();
  const offRes = await off.call('/auth/google');
  const offScope = new URL(offRes.headers.get('location')!).searchParams.get('scope')!.split(' ');
  assert.ok(offScope.includes(GOOGLE_SCOPE_READONLY));
  assert.ok(!offScope.includes(GOOGLE_SCOPE_ANALYTICS_READONLY));
  assert.equal(new URL(offRes.headers.get('location')!).searchParams.get('include_granted_scopes'), 'true');

  const legacyFlag = setup({ GA4_ENABLED: 'true' });
  const legacyRes = await legacyFlag.call('/auth/google');
  const legacyScope = new URL(legacyRes.headers.get('location')!).searchParams.get('scope')!.split(' ');
  assert.ok(!legacyScope.includes(GOOGLE_SCOPE_ANALYTICS_READONLY));

  const on = setup();
  const onRes = await on.call('/auth/google?ga4=1');
  const onScope = new URL(onRes.headers.get('location')!).searchParams.get('scope')!.split(' ');
  assert.ok(onScope.includes(GOOGLE_SCOPE_READONLY));
  assert.ok(onScope.includes(GOOGLE_SCOPE_ANALYTICS_READONLY));
  assert.ok(onScope.includes('openid'));
});

test('callback refuses a grant without analytics.readonly when ?ga4=1 asked for it', async () => {
  const kv = new MemoryKv();
  setEnvSource({
    MCP_AUTH_MODE: 'bearer',
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: HOST,
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GSC_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
  });
  const app = buildApp('worker');
  const call = (path: string) =>
    app.request(`https://${HOST}${path}`, { headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
  const start = await call('/auth/google?ga4=1');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ refresh_token: 'r', scope: `${GOOGLE_SCOPE_READONLY} openid email` });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /insufficient_scope/);
  assert.match(body, /Google Analytics/);
  assert.match(body, /\/auth\/google\?ga4=1/);
  assert.equal([...kv.data.keys()].some((k) => k.startsWith('google:account:') || k === 'google:refresh-token'), false);
});

// ---------- tools ----------

test('ga4_run_report sends camelCase REST to the Data API and maps snake_case filters', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    (call) => {
      if (call.url.pathname.endsWith(':runReport')) return json({ rowCount: 1, rows: [] });
      return json({ error: { message: `unexpected ${call.url}` } }, 500);
    },
  );
  const result = await run('ga4_run_report', {
    property_id: '123456',
    date_ranges: [{ start_date: '7daysAgo', end_date: 'yesterday', name: 'last7' }],
    dimensions: ['date'],
    metrics: ['sessions'],
    dimension_filter: { filter: { field_name: 'sessionDefaultChannelGroup', string_filter: { match_type: 'EXACT', value: 'Organic Search' } } },
    limit: 50,
    return_property_quota: true,
  });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.method, 'POST');
  assert.equal(c.url.href, 'https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport');
  assert.equal(c.headers.Authorization, 'Bearer at-rt-ada');
  assert.deepEqual(c.body, {
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday', name: 'last7' }],
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } },
    limit: 50,
    returnPropertyQuota: true,
  });
});

test('ga4_get_account_summaries paginates and tags the Google account', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    (call) => {
      if (!call.url.pathname.endsWith('/accountSummaries')) return json({ error: { message: 'no' } }, 500);
      if (!call.url.searchParams.get('pageToken')) {
        return json({
          accountSummaries: [{ account: 'accounts/1', displayName: 'A' }],
          nextPageToken: 'p2',
        });
      }
      return json({ accountSummaries: [{ account: 'accounts/2', displayName: 'B' }] });
    },
  );
  const result = await run('ga4_get_account_summaries', {});
  assert.notEqual(result.isError, true, result.content[0]!.text);
  const body = JSON.parse(result.content[0]!.text) as {
    results: { account: string; count: number; account_summaries: { account: string }[] }[];
  };
  assert.equal(body.results[0]!.account, 'ada@example.com');
  assert.equal(body.results[0]!.count, 2);
  assert.deepEqual(
    body.results[0]!.account_summaries.map((s) => s.account),
    ['accounts/1', 'accounts/2'],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.searchParams.get('pageToken'), 'p2');
});

test('ga4_get_custom_dimensions_and_metrics keeps only customDefinition fields', async () => {
  const { run } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    () =>
      json({
        dimensions: [
          { apiName: 'date', customDefinition: false },
          { apiName: 'customEvent:topic', customDefinition: true },
        ],
        metrics: [
          { apiName: 'sessions', customDefinition: false },
          { apiName: 'customEvent:score', customDefinition: true },
        ],
      }),
  );
  const result = await run('ga4_get_custom_dimensions_and_metrics', { property_id: 'properties/9' });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  const body = JSON.parse(result.content[0]!.text) as { custom_dimensions: { apiName: string }[]; custom_metrics: { apiName: string }[] };
  assert.deepEqual(body.custom_dimensions.map((d) => d.apiName), ['customEvent:topic']);
  assert.deepEqual(body.custom_metrics.map((m) => m.apiName), ['customEvent:score']);
});

test('ga4_run_funnel_report expands {event} steps onto the alpha funnel endpoint', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    () => json({ funnelTable: [] }),
  );
  const result = await run('ga4_run_funnel_report', {
    property_id: 99,
    funnel_steps: [{ name: 'View', event: 'page_view' }, { name: 'Buy', event: 'purchase' }],
    date_ranges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    funnel_breakdown: { breakdown_dimension: 'deviceCategory' },
  });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  assert.equal(calls[0]!.url.href, 'https://analyticsdata.googleapis.com/v1alpha/properties/99:runFunnelReport');
  assert.deepEqual(calls[0]!.body, {
    funnel: {
      steps: [
        { name: 'View', filterExpression: { funnelEventFilter: { eventName: 'page_view' } } },
        { name: 'Buy', filterExpression: { funnelEventFilter: { eventName: 'purchase' } } },
      ],
    },
    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    funnelBreakdown: { breakdownDimension: { name: 'deviceCategory' } },
  });
});

test('ga4_run_conversions_report posts conversionSpec to the alpha runReport path', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    () => json({ rows: [] }),
  );
  const result = await run('ga4_run_conversions_report', {
    property_id: '1',
    date_ranges: [{ start_date: 'yesterday', end_date: 'yesterday' }],
    dimensions: ['campaignName'],
    metrics: ['allConversionsByConversionDate'],
    conversion_spec: { conversion_actions: [], attribution_model: 'DATA_DRIVEN' },
  });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  assert.equal(calls[0]!.url.pathname, '/v1alpha/properties/1:runReport');
  const body = calls[0]!.body as { conversionSpec: unknown };
  assert.deepEqual(body.conversionSpec, { conversionActions: [], attributionModel: 'DATA_DRIVEN' });
});

test('ga4_check_compatibility and Admin reads hit the documented REST paths', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    (call) => {
      if (call.url.pathname.includes('googleAdsLinks')) return json({ googleAdsLinks: [{ name: 'l1' }] });
      if (call.url.pathname.includes('reportingDataAnnotations')) return json({ reportingDataAnnotations: [] });
      if (call.url.pathname.includes('checkCompatibility')) return json({ dimensionCompatibilities: [] });
      if (call.method === 'GET' && call.url.pathname === '/v1beta/properties/7') return json({ displayName: 'Shop' });
      if (call.url.pathname.includes('runRealtimeReport')) return json({ rows: [] });
      return json({ error: { message: call.url.pathname } }, 500);
    },
  );
  assert.notEqual((await run('ga4_get_property_details', { property_id: '7' })).isError, true);
  assert.notEqual((await run('ga4_list_google_ads_links', { property_id: '7' })).isError, true);
  assert.notEqual((await run('ga4_list_property_annotations', { property_id: '7' })).isError, true);
  assert.notEqual((await run('ga4_check_compatibility', { property_id: '7', dimensions: ['date'], metrics: ['sessions'] })).isError, true);
  assert.notEqual((await run('ga4_run_realtime_report', { property_id: '7', dimensions: ['country'], metrics: ['activeUsers'] })).isError, true);
  const paths = calls.map((c) => `${c.method} ${c.url.pathname}`);
  assert.ok(paths.includes('GET /v1beta/properties/7'));
  assert.ok(paths.includes('GET /v1beta/properties/7/googleAdsLinks'));
  assert.ok(paths.includes('GET /v1alpha/properties/7/reportingDataAnnotations'));
  assert.ok(paths.includes('POST /v1beta/properties/7:checkCompatibility'));
  assert.ok(paths.includes('POST /v1beta/properties/7:runRealtimeReport'));
});

test('ga4_run_report is refused when the stored grant has no analytics scope', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': GOOGLE_SCOPE_READONLY },
    () => json({ rowCount: 1 }),
  );
  const result = await run('ga4_run_report', {
    property_id: '1',
    date_ranges: [{ start_date: 'yesterday', end_date: 'yesterday' }],
    dimensions: ['date'],
    metrics: ['sessions'],
  });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as { error: string; required_scope: string; resolution: string };
  assert.equal(body.error, 'insufficient_granted_scope');
  assert.equal(body.required_scope, GOOGLE_SCOPE_ANALYTICS_READONLY);
  assert.match(body.resolution, /analytics\.readonly/);
  assert.match(body.resolution, /--ga4/);
  assert.equal(calls.length, 0);
});

test('unknown granted scope is allowed through and a 403 names the Analytics re-consent', async () => {
  const { run } = await withAccounts({ 'ada@example.com': null }, () =>
    json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403),
  );
  const result = await run('ga4_get_property_details', { property_id: '1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Permission denied \(HTTP 403\)/);
  assert.match(result.content[0]!.text, /analytics\.readonly/);
});

test('property calls try the next Google account after 403', async () => {
  const { run, calls } = await withAccounts(
    {
      'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
      'bob@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
    },
    (call) => {
      const token = call.headers.Authorization;
      if (token.includes('ada')) return json({ error: { message: 'forbidden' } }, 403);
      return json({ displayName: 'Bob property' });
    },
  );
  const result = await run('ga4_get_property_details', { property_id: '5' });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  assert.deepEqual(calls.map((c) => c.headers.Authorization), ['Bearer at-rt-ada', 'Bearer at-rt-bob']);
  assert.match(result.content[0]!.text, /Bob property/);
});

test('Ga4ApiError surfaces quota and invalid property IDs never call Google', async () => {
  const { run, calls } = await withAccounts(
    { 'ada@example.com': `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}` },
    () => json({ error: { message: 'Quota exceeded', details: [{ reason: 'quotaExceeded' }] } }, 429),
  );
  const quota = await run('ga4_run_realtime_report', {
    property_id: '1',
    dimensions: ['country'],
    metrics: ['activeUsers'],
  });
  assert.equal(quota.isError, true);
  assert.match(quota.content[0]!.text, /quota exceeded/i);
  const bad = await run('ga4_get_property_details', { property_id: 'not-a-property' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /Invalid property ID/);
  assert.equal(calls.length, 4, '429 is retried then mapped to a quota error; the invalid id never calls Google');
});

test('a cached 401 is retried once with a fresh access token', async () => {
  let tokenCalls = 0;
  const kv = new MemoryKv();
  const store = new GoogleTokenStore(kv, KEY);
  await store.save('rt-ada', {
    scope: `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
    grantedScope: `${GOOGLE_SCOPE_READONLY} ${GOOGLE_SCOPE_ANALYTICS_READONLY}`,
    clientId: CLIENT,
    email: 'ada@example.com',
  });
  const tokenFetch = (async () => {
    tokenCalls++;
    return Response.json({ access_token: `at-${tokenCalls}`, expires_in: 3600 });
  }) as typeof fetch;
  setEnvSource({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'sec' });
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google, tokenFetch, { store });
  const { calls, fetchImpl } = mockFetch((call) => {
    if (call.headers.Authorization === 'Bearer at-1') return json({ error: { message: 'expired' } }, 401);
    return json({ displayName: 'ok' });
  });
  const client = new Ga4Client({ tokenProvider, fetchImpl, sleep: async () => undefined });
  const out = await client.request<{ displayName: string }>(
    'https://analyticsadmin.googleapis.com',
    '/v1beta/properties/1',
  );
  assert.equal(out.displayName, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(tokenCalls, 2);
});

test('Ga4ApiError name is stable for callers', () => {
  const e = new Ga4ApiError(404, 'missing', 'notFound');
  assert.equal(e.name, 'Ga4ApiError');
  assert.equal(e.status, 404);
  assert.equal(e.reason, 'notFound');
});
