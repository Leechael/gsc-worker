/**
 * Tool contract regressions:
 * - optional arguments accept an explicit JSON null
 * - failures set isError; empty data does not
 * - compare_search_periods deltas are period 1 relative to period 2
 * - sort is client-side and the query body never sends orderBy
 * - batch inspection overlaps instead of running one URL at a time
 * - token refresh does not send a scope parameter
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';
import { parseConfig } from '../src/lib/config.js';
import { TokenProvider, TokenRefreshError } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerAdvancedAnalyticsTools } from '../src/tools/analytics-advanced.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';
import { registerInspectionTools } from '../src/tools/inspection.js';
import { registerPropertiesTools } from '../src/tools/properties.js';
import { registerSitemapsTools } from '../src/tools/sitemaps.js';
import { jsonError } from '../src/tools/helpers.js';

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

interface RegisteredTool {
  inputSchema: ZodType;
  executor: (args: unknown, ctx: unknown) => Promise<ToolResult>;
}

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function harness(
  respond: (url: string, body: Record<string, unknown> | undefined) => unknown,
): { svc: ServerServices; calls: { url: string; body?: Record<string, unknown> }[] } {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify(respond(url, body)), { status: 200 });
  }) as typeof fetch;
  const config = parseConfig();
  return { svc: { config, tokenProvider, gsc: new GscClient({ tokenProvider, fetchImpl }) }, calls };
}

const ADVANCED_REQUIRED = {
  site_url: 'sc-domain:example.com',
  dimensions: 'query',
  search_type: 'web',
  row_limit: 20,
  start_row: 0,
  sort_by: 'clicks',
  sort_direction: 'descending',
  filter_operator: 'contains',
};

function schemaAllowsNull(prop: { type?: string | string[]; anyOf?: { type?: string | string[] }[] }): boolean {
  const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
  if (types.includes('null')) return true;
  return (prop.anyOf ?? []).some((branch) => {
    const branchTypes = Array.isArray(branch.type) ? branch.type : branch.type ? [branch.type] : [];
    return branchTypes.includes('null');
  });
}

// ---------- explicit null on optional arguments ----------

const NULLABLE_FIELDS: Record<string, string[]> = {
  get_advanced_search_analytics: [
    'start_date', 'end_date', 'max_rows', 'filter_dimension', 'filter_expression', 'filters', 'data_state',
    'dimensions', 'search_type', 'row_limit', 'start_row', 'sort_by', 'sort_direction', 'filter_operator',
  ],
  list_sitemaps_enhanced: ['sitemap_index'],
  manage_sitemaps: ['sitemap_url', 'sitemap_index'],
};

test('optional tool arguments advertise and accept explicit null', () => {
  const server = buildMcpServer();
  const tools = toolsOf(server);
  for (const [name, fields] of Object.entries(NULLABLE_FIELDS)) {
    const tool = tools[name];
    assert.ok(tool, `${name} is registered`);
    const json = tool.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties: Record<string, { type?: string | string[]; anyOf?: { type?: string | string[] }[] }>;
    };
    const base = name === 'manage_sitemaps'
      ? { site_url: 'https://example.com/', action: 'list' }
      : { site_url: 'https://example.com/' };
    for (const field of fields) {
      const prop = json.properties[field];
      assert.ok(prop, `${name}.${field} is in the input schema`);
      assert.ok(schemaAllowsNull(prop), `${name}.${field} schema allows null: ${JSON.stringify(prop)}`);
      const parsed = tool.inputSchema.safeParse({ ...base, [field]: null });
      assert.equal(parsed.success, true, `${name}.${field} rejected null`);
    }
  }
});

test('explicit null optionals are treated as omitted, not as filters', async () => {
  const { svc, calls } = harness(() => ({ rows: [] }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const result = await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED_REQUIRED,
    start_date: null,
    end_date: null,
    max_rows: null,
    filter_dimension: null,
    filter_expression: null,
    filters: null,
    data_state: null,
  }, {});
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body!;
  assert.equal(body.dimensionFilterGroups, undefined);
  assert.match(String(body.startDate), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(body.endDate), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal('orderBy' in body, false);
});

test('list_sitemaps_enhanced drops a null sitemap_index query param', async () => {
  const { svc, calls } = harness(() => ({ sitemap: [] }));
  const server = new McpServer({ name: 't', version: '0' });
  registerSitemapsTools(server, svc);
  const result = await toolsOf(server).list_sitemaps_enhanced!.executor({
    site_url: 'https://example.com/',
    sitemap_index: null,
  }, {});
  assert.notEqual(result.isError, true);
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.has('sitemapIndex'), false);
});

// ---------- failures set isError; empty data does not ----------

test('API failures set isError and keep the message', async () => {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: { code: 404, message: 'not found' },
  }), { status: 404 })) as typeof fetch;
  const svc: ServerServices = {
    config: parseConfig(),
    tokenProvider,
    gsc: new GscClient({ tokenProvider, fetchImpl, maxAttempts: 1 }),
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(server, svc);
  const result = await toolsOf(server).list_properties!.executor({}, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Error retrieving properties|not found|HTTP 404/);
  assert.doesNotMatch(result.content[0]!.text, /Error executing tool/);
});

test('validation failures set isError; an empty result does not', async () => {
  const { svc } = harness(() => ({ rows: [] }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAnalyticsTools(server, svc);
  const bad = await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 28,
    dimensions: 'not-a-dimension',
    row_limit: 20,
  }, {});
  assert.equal(bad.isError, true);
  const parsed = JSON.parse(bad.content[0]!.text) as { error?: string };
  assert.match(parsed.error ?? '', /Invalid dimensions/);

  const empty = await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 28,
    dimensions: 'query',
    row_limit: 20,
  }, {});
  assert.notEqual(empty.isError, true);
  const emptyBody = JSON.parse(empty.content[0]!.text) as { row_count: number };
  assert.equal(emptyBody.row_count, 0);
});

test('a scope-tier refusal is an error result', async () => {
  const { svc } = harness(() => ({}));
  svc.config.scopeTier = 'read';
  const server = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(server, svc);
  const result = await toolsOf(server).add_site!.executor({ site_url: 'https://example.com/' }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /disabled at the current scope tier/);
});

test('manage_sitemaps submit and delete are refused at the read tier without calling Google', async () => {
  const { svc, calls } = harness(() => ({}));
  svc.config.scopeTier = 'read';
  const server = new McpServer({ name: 't', version: '0' });
  registerSitemapsTools(server, svc);
  for (const action of ['submit', 'delete']) {
    const result = await toolsOf(server).manage_sitemaps!.executor(
      { site_url: 'sc-domain:example.com', action, sitemap_url: 'https://example.com/sitemap.xml' },
      {},
    );
    assert.equal(result.isError, true, action);
    assert.match(result.content[0]!.text, new RegExp(`^Safety: ${action}_sitemap `), action);
  }
  assert.equal(calls.length, 0);
});

test('explicit null on defaulted advanced-analytics arguments keeps the default', () => {
  const tool = toolsOf(buildMcpServer()).get_advanced_search_analytics!;
  const parsed = tool.inputSchema.safeParse({
    site_url: 'https://example.com/',
    dimensions: null,
    search_type: null,
    row_limit: null,
    start_row: null,
    sort_by: null,
    sort_direction: null,
    filter_operator: null,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const data = parsed.data as {
    dimensions: string;
    search_type: string;
    row_limit: number;
    start_row: number;
    sort_by: string;
    sort_direction: string;
    filter_operator: string;
  };
  assert.equal(data.dimensions, 'query');
  assert.equal(data.search_type, 'web');
  assert.equal(data.row_limit, 1000);
  assert.equal(data.start_row, 0);
  assert.equal(data.sort_by, 'clicks');
  assert.equal(data.sort_direction, 'descending');
  assert.equal(data.filter_operator, 'contains');
});

test('a one-sided advanced filter is an error and does not query', async () => {
  const { svc, calls } = harness(() => ({ rows: [] }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const missingExpression = await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED_REQUIRED,
    filter_dimension: 'query',
    filter_expression: null,
  }, {});
  assert.equal(missingExpression.isError, true);
  const body = JSON.parse(missingExpression.content[0]!.text) as { error?: string };
  assert.match(body.error ?? '', /filter_dimension and filter_expression must be provided together/);
  assert.equal(calls.length, 0);

  const missingDimension = await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED_REQUIRED,
    filter_dimension: null,
    filter_expression: 'brand',
  }, {});
  assert.equal(missingDimension.isError, true);
  assert.equal(calls.length, 0);
});

test('jsonError turns an undefined payload into JSON null', () => {
  const result = jsonError(undefined);
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, 'null');
});

function statusSvc(status: number, body: unknown, scopeTier: 'read' | 'destructive' = 'read'): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status },
  )) as typeof fetch;
  return {
    config: { ...parseConfig(), scopeTier },
    tokenProvider,
    gsc: new GscClient({ tokenProvider, fetchImpl, maxAttempts: 1 }),
  };
}

test('add_site 409 and delete_site 404 are already the requested state', async () => {
  const addServer = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(addServer, statusSvc(409, { error: { code: 409, message: 'Conflict' } }, 'destructive'));
  const added = await toolsOf(addServer).add_site!.executor({ site_url: 'https://example.com/' }, {});
  assert.notEqual(added.isError, true);
  assert.match(added.content[0]!.text, /already added/);

  const deleteServer = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(deleteServer, statusSvc(404, { error: { code: 404, message: 'Not Found' } }, 'destructive'));
  const removed = await toolsOf(deleteServer).delete_site!.executor({ site_url: 'https://example.com/' }, {});
  assert.notEqual(removed.isError, true);
  assert.match(removed.content[0]!.text, /was not found/);

  const denied = new McpServer({ name: 't', version: '0' });
  registerPropertiesTools(denied, statusSvc(403, {
    error: { code: 403, message: 'forbidden', details: [{ reason: 'forbidden' }] },
  }, 'destructive'));
  const failure = await toolsOf(denied).add_site!.executor({ site_url: 'https://example.com/' }, {});
  assert.equal(failure.isError, true);
});

test('an empty sitemap details body is not an error', async () => {
  const svc = statusSvc(200, '');
  const server = new McpServer({ name: 't', version: '0' });
  registerSitemapsTools(server, svc);
  const result = await toolsOf(server).get_sitemap_details!.executor({
    site_url: 'https://example.com/',
    sitemap_url: 'https://example.com/sitemap.xml',
  }, {});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]!.text, /No details found/);
});

const INDEXED_INSPECTION = {
  inspectionResult: {
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      pageFetchState: 'SUCCESSFUL',
      robotsTxtState: 'ALLOWED',
    },
  },
};

function inspectionSvc(
  respond: (pageUrl: string) => { status: number; body: unknown },
): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { inspectionUrl?: string } : {};
    const response = respond(body.inspectionUrl ?? '');
    const payload = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(payload, { status: response.status });
  }) as typeof fetch;
  return {
    config: parseConfig(),
    tokenProvider,
    gsc: new GscClient({ tokenProvider, fetchImpl, maxAttempts: 1 }),
  };
}

test('a batch where every URL fails sets isError; a mixed batch does not', async () => {
  const forbidden = { error: { code: 403, message: 'Permission denied' } };
  const allFailed = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(allFailed, inspectionSvc(() => ({ status: 403, body: forbidden })));
  const failed = await toolsOf(allFailed).batch_url_inspection!.executor({
    site_url: 'sc-domain:example.com',
    urls: 'https://example.com/a\nhttps://example.com/b',
  }, {});
  assert.equal(failed.isError, true);
  const failedBody = JSON.parse(failed.content[0]!.text) as { results: { error?: string }[] };
  assert.equal(failedBody.results.length, 2);
  assert.ok(failedBody.results.every((row) => typeof row.error === 'string'));

  const mixed = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(mixed, inspectionSvc((pageUrl) => (
    pageUrl.endsWith('/b')
      ? { status: 403, body: forbidden }
      : { status: 200, body: INDEXED_INSPECTION }
  )));
  const partial = await toolsOf(mixed).batch_url_inspection!.executor({
    site_url: 'sc-domain:example.com',
    urls: 'https://example.com/a\nhttps://example.com/b',
  }, {});
  assert.notEqual(partial.isError, true);
  const partialBody = JSON.parse(partial.content[0]!.text) as {
    results: { url?: string; error?: string; index_verdict?: string }[];
  };
  assert.equal(partialBody.results.length, 2);
  assert.equal(partialBody.results[0]!.url, 'https://example.com/a');
  assert.equal(partialBody.results[0]!.error, undefined);
  assert.equal(partialBody.results[0]!.index_verdict, 'PASS');
  assert.equal(partialBody.results[1]!.url, 'https://example.com/b');
  assert.equal(typeof partialBody.results[1]!.error, 'string');
});

test('indexing request failures stay out of not_indexed and fail the call when every URL fails', async () => {
  const forbidden = { error: { code: 403, message: 'Permission denied' } };
  const allFailed = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(allFailed, inspectionSvc(() => ({ status: 403, body: forbidden })));
  const failed = await toolsOf(allFailed).check_indexing_issues!.executor({
    site_url: 'sc-domain:example.com',
    urls: 'https://example.com/a\nhttps://example.com/b',
  }, {});
  assert.equal(failed.isError, true);
  const failedBody = JSON.parse(failed.content[0]!.text) as {
    request_failures?: string[];
    summary?: { not_indexed: number };
  };
  assert.equal(failedBody.request_failures?.length, 2);
  assert.equal(failedBody.summary, undefined);

  const mixed = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(mixed, inspectionSvc((pageUrl) => (
    pageUrl.endsWith('/b')
      ? { status: 403, body: forbidden }
      : { status: 200, body: INDEXED_INSPECTION }
  )));
  const partial = await toolsOf(mixed).check_indexing_issues!.executor({
    site_url: 'sc-domain:example.com',
    urls: 'https://example.com/a\nhttps://example.com/b',
  }, {});
  assert.notEqual(partial.isError, true);
  const partialBody = JSON.parse(partial.content[0]!.text) as {
    summary: { indexed: number; not_indexed: number; request_failures: number };
    request_failures: string[];
    issues: { not_indexed: string[] };
  };
  assert.equal(partialBody.summary.indexed, 1);
  assert.equal(partialBody.summary.not_indexed, 0);
  assert.equal(partialBody.summary.request_failures, 1);
  assert.equal(partialBody.issues.not_indexed.length, 0);
  assert.equal(partialBody.request_failures.length, 1);
});

// ---------- period deltas ----------

function comparisonRow(
  rows: { start: string; clicks: number; impressions: number; ctr: number; position: number }[],
): Record<string, unknown> {
  return {
    rows: rows.map((row) => ({
      keys: ['query-a'],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })),
  };
}

async function compare(period1: { clicks: number; impressions: number; ctr: number; position: number }, period2: { clicks: number; impressions: number; ctr: number; position: number }) {
  const { svc } = harness((_url, body) => {
    const start = String(body?.startDate);
    const row = start === '2026-02-01' ? period1 : period2;
    return comparisonRow([{ start, ...row }]);
  });
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const result = await toolsOf(server).compare_search_periods!.executor({
    site_url: 'sc-domain:example.com',
    period1_start: '2026-02-01',
    period1_end: '2026-02-28',
    period2_start: '2026-01-01',
    period2_end: '2026-01-31',
    dimensions: 'query',
    limit: 10,
  }, {});
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as { comparison: Record<string, unknown>[] };
  return body.comparison[0]!;
}

test('compare_search_periods: Period 1 growth is positive against Period 2', async () => {
  const row = await compare(
    { clicks: 78, impressions: 200, ctr: 0.39, position: 10.6 },
    { clicks: 51, impressions: 100, ctr: 0.2, position: 14.4 },
  );
  assert.equal(row.click_diff, 27);
  assert.equal(row.click_pct, 52.9);
  assert.equal(row.imp_diff, 100);
  assert.equal(row.position_diff, 3.8);
});

test('compare_search_periods: Period 1 decline is negative', async () => {
  const row = await compare(
    { clicks: 40, impressions: 80, ctr: 0.1, position: 18 },
    { clicks: 80, impressions: 100, ctr: 0.2, position: 10 },
  );
  assert.equal(row.click_diff, -40);
  assert.equal(row.click_pct, -50);
  assert.equal(row.position_diff, -8);
});

test('compare_search_periods: a zero Period 2 baseline yields null percentages', async () => {
  const row = await compare(
    { clicks: 5, impressions: 10, ctr: 0.5, position: 8 },
    { clicks: 0, impressions: 0, ctr: 0, position: 12 },
  );
  assert.equal(row.click_diff, 5);
  assert.equal(row.click_pct, null);
  assert.equal(row.imp_pct, null);
});

// ---------- client-side sort, no orderBy ----------

test('get_search_by_page_query does not send orderBy', async () => {
  const { svc, calls } = harness(() => ({
    rows: [{ keys: ['q'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }],
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  await toolsOf(server).get_search_by_page_query!.executor({
    site_url: 'sc-domain:example.com',
    page_url: 'https://example.com/a',
    days: 28,
    row_limit: 20,
  }, {});
  assert.equal('orderBy' in (calls[0]!.body ?? {}), false);
});

test('non-click sort reorders the returned page and warns it is not global', async () => {
  const rows = [
    { keys: ['clicked'], clicks: 50, impressions: 10, ctr: 0.5, position: 3 },
    { keys: ['seen'], clicks: 1, impressions: 500, ctr: 0.01, position: 12 },
  ];
  const { svc, calls } = harness(() => ({ rows }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const sorted = await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED_REQUIRED,
    sort_by: 'impressions',
    sort_direction: 'descending',
  }, {});
  const body = JSON.parse(sorted.content[0]!.text) as {
    rows: { query: string }[];
    sort_note?: string;
  };
  assert.equal(body.rows[0]!.query, 'seen');
  assert.equal(body.rows[1]!.query, 'clicked');
  assert.match(body.sort_note ?? '', /not a global sort/);
  assert.equal('orderBy' in (calls[0]!.body ?? {}), false);

  const native = await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED_REQUIRED,
    sort_by: 'clicks',
    sort_direction: 'descending',
  }, {});
  const nativeBody = JSON.parse(native.content[0]!.text) as { rows: { query: string }[]; sort_note?: string };
  assert.equal(nativeBody.rows[0]!.query, 'clicked');
  assert.equal(nativeBody.sort_note, undefined);
});

// ---------- batch inspection overlaps ----------

test('batch_url_inspection and check_indexing_issues overlap requests', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return new Response(JSON.stringify({
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          pageFetchState: 'SUCCESSFUL',
          robotsTxtState: 'ALLOWED',
        },
      },
    }), { status: 200 });
  }) as typeof fetch;
  const svc: ServerServices = {
    config: parseConfig(),
    tokenProvider,
    gsc: new GscClient({ tokenProvider, fetchImpl }),
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(server, svc);
  const urls = 'https://example.com/a\nhttps://example.com/b';
  maxInFlight = 0;
  const batch = await toolsOf(server).batch_url_inspection!.executor({
    site_url: 'sc-domain:example.com',
    urls,
  }, {});
  assert.notEqual(batch.isError, true);
  assert.ok(maxInFlight >= 2, `batch overlapped (max in flight ${maxInFlight})`);

  maxInFlight = 0;
  const issues = await toolsOf(server).check_indexing_issues!.executor({
    site_url: 'sc-domain:example.com',
    urls,
  }, {});
  assert.notEqual(issues.isError, true);
  assert.ok(maxInFlight >= 2, `indexing check overlapped (max in flight ${maxInFlight})`);
});

// ---------- refresh must not send a scope ----------

test('token refresh omits scope and does not treat invalid_scope as invalid_grant', async () => {
  let posted = '';
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    posted = String(init?.body ?? '');
    return new Response(JSON.stringify({
      error: 'invalid_scope',
      error_description: 'Bad Request',
    }), { status: 400 });
  }) as typeof fetch;
  const provider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'readonly-grant', scopes: [] },
    fetchImpl,
  );
  await assert.rejects(
    () => provider.getAccessToken(),
    (err: unknown) => {
      assert.ok(err instanceof TokenRefreshError);
      assert.equal(err.invalidGrant, false);
      assert.match(err.message, /invalid_scope/);
      assert.doesNotMatch(err.message, /deleted|token\.json/i);
      return true;
    },
  );
  assert.equal(posted.includes('scope='), false);
  const params = new URLSearchParams(posted);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'readonly-grant');
});
