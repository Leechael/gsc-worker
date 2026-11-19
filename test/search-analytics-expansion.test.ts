/**
 * Search Analytics expansion on existing tools: webMultimodal type,
 * brandedClassification grouping/filters, and filterLists on the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerAdvancedAnalyticsTools } from '../src/tools/analytics-advanced.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';
import { FILTER_LIST_MAX_EXPRESSIONS } from '../src/lib/enums.js';
import { BRANDED_EMPTY_NOTE } from '../src/lib/search-analytics-constraints.js';

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

interface RegisteredTool {
  description?: string;
  executor: (args: unknown, ctx: unknown) => Promise<ToolResult>;
}

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function harness(
  respond: (url: string, body: Record<string, unknown> | undefined) => unknown,
  calls: Record<string, unknown>[],
): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (body) calls.push(body);
    return new Response(JSON.stringify(respond(url, body)), { status: 200 });
  }) as typeof fetch;
  return { config: parseConfig(), tokenProvider, gsc: new GscClient({ tokenProvider, fetchImpl }) };
}

const ADVANCED = {
  site_url: 'sc-domain:example.com',
  start_date: '2026-03-01',
  end_date: '2026-03-07',
  dimensions: 'page',
  search_type: 'web',
  row_limit: 20,
  start_row: 0,
  sort_by: 'clicks',
  sort_direction: 'descending',
  filter_operator: 'equals',
};

function parseJson(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('get_search_analytics sends webMultimodal and rejects query grouping', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({
    rows: [{ keys: ['https://example.com/'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }],
    responseAggregationType: 'byPage',
  }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAnalyticsTools(server, svc);

  const ok = parseJson(await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    dimensions: 'page',
    search_type: 'webMultimodal',
    row_limit: 20,
  }, {}));
  assert.equal(ok.search_type, 'webMultimodal');
  assert.equal(ok.response_aggregation_type, 'byPage');
  assert.equal(calls[0]!.type, 'webMultimodal');
  assert.deepEqual(calls[0]!.dimensions, ['page']);

  const rejected = parseJson(await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    dimensions: 'query',
    search_type: 'webMultimodal',
    row_limit: 20,
  }, {}));
  assert.match(String(rejected.error), /webMultimodal cannot group by the query dimension/);
  assert.equal(calls.length, 1);
});

test('existing search types still map to their wire values', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  for (const type of ['web', 'image', 'video', 'news', 'discover', 'googleNews']) {
    await toolsOf(server).get_advanced_search_analytics!.executor({
      ...ADVANCED,
      search_type: type,
    }, {});
    assert.equal(calls.at(-1)!.type, type);
  }
});

test('brandedClassification grouping and equals filter reach the API', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({
    rows: [{ keys: ['BRANDED'], clicks: 4, impressions: 10, ctr: 0.4, position: 2 }],
    responseAggregationType: 'byProperty',
    metadata: { firstIncompleteDate: '2026-03-07' },
  }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);

  const body = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    dimensions: 'brandedClassification',
    filters: JSON.stringify([{
      dimension: 'page',
      operator: 'contains',
      expression: '/pricing',
    }]),
  }, {}));
  assert.equal(body.response_aggregation_type, 'byProperty');
  assert.equal((body.metadata as { first_incomplete_date: string }).first_incomplete_date, '2026-03-07');
  assert.deepEqual(calls[0]!.dimensions, ['brandedClassification']);
  const groups = calls[0]!.dimensionFilterGroups as { filters: unknown[]; filterLists?: unknown }[];
  assert.deepEqual(groups[0]!.filters, [{
    dimension: 'page',
    operator: 'contains',
    expression: '/pricing',
  }]);
  assert.equal('filterLists' in groups[0]!, false);

  const filtered = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    dimensions: 'page',
    filter_dimension: 'brandedClassification',
    filter_operator: 'equals',
    filter_expression: 'branded',
  }, {}));
  assert.equal((filtered.pagination as { row_count: number }).row_count, 1);
  const brandedGroups = calls[1]!.dimensionFilterGroups as { filters: { expression: string }[] }[];
  assert.equal(brandedGroups[0]!.filters[0]!.expression, 'BRANDED');
});

test('brandedClassification plus a query filter is refused in the same request', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const rejected = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    dimensions: 'brandedClassification',
    filters: JSON.stringify([
      { dimension: 'query', operator: 'contains', expression: 'acme' },
    ]),
  }, {}));
  assert.match(String(rejected.error), /cannot be combined with a query filter/);
  assert.equal(calls.length, 0);
});

test('empty brandedClassification results explain eligibility instead of zero traffic', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [], responseAggregationType: 'auto' }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAnalyticsTools(server, svc);
  const empty = parseJson(await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    dimensions: 'brandedClassification',
    search_type: 'web',
    row_limit: 20,
  }, {}));
  assert.equal(empty.row_count, 0);
  assert.equal(empty.response_aggregation_type, 'auto');
  assert.match(String(empty.note), new RegExp(BRANDED_EMPTY_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(calls.length, 1);
});

test('filter_lists of 1000 country codes are sent as filterLists; 1001 is refused', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);

  const thousand = Array.from({ length: FILTER_LIST_MAX_EXPRESSIONS }, (_, i) => `c${String(i).padStart(3, '0')}`);
  const ok = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    filter_lists: JSON.stringify([{ dimension: 'country', expressions: thousand }]),
  }, {}));
  assert.equal(ok.row_count, 0);
  const groups = calls[0]!.dimensionFilterGroups as {
    groupType: string;
    filterLists: { dimension: string; expressions: string[] }[];
  }[];
  assert.equal(groups[0]!.groupType, 'AND');
  assert.equal(groups[0]!.filterLists[0]!.dimension, 'country');
  assert.equal(groups[0]!.filterLists[0]!.expressions.length, 1000);
  assert.equal(groups[0]!.filterLists[0]!.expressions[999], 'c999');
  assert.equal('filters' in groups[0]!, false);

  const over = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    filter_lists: JSON.stringify([{
      dimension: 'device',
      expressions: Array.from({ length: 1001 }, (_, i) => `d${i}`),
    }]),
  }, {}));
  assert.match(String(over.error), /1001 expressions/);
  assert.match(String(over.error), /maximum is 1000 per list/);
  assert.equal(calls.length, 1);
});

test('the same dimension cannot appear in filters and filter_lists', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const rejected = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    filters: JSON.stringify([{ dimension: 'device', operator: 'equals', expression: 'MOBILE' }]),
    filter_lists: JSON.stringify([{ dimension: 'device', expressions: ['DESKTOP', 'TABLET'] }]),
  }, {}));
  assert.match(String(rejected.error), /cannot appear in both filters and filter_lists/);
  assert.equal(calls.length, 0);
});

test('ordinary filters plus a different-dimension filter list are sent together', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({
    rows: [{ keys: ['https://example.com/a'], clicks: 2, impressions: 4, ctr: 0.5, position: 1 }],
  }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    filters: JSON.stringify([{ dimension: 'page', operator: 'contains', expression: '/a' }]),
    filter_lists: JSON.stringify([
      { dimension: 'country', expressions: ['usa', 'gbr'] },
      { dimension: 'device', expressions: ['MOBILE'] },
    ]),
  }, {});
  const group = (calls[0]!.dimensionFilterGroups as Record<string, unknown>[])[0]!;
  assert.deepEqual(group.filters, [{ dimension: 'page', operator: 'contains', expression: '/a' }]);
  assert.deepEqual(group.filterLists, [
    { dimension: 'country', expressions: ['usa', 'gbr'] },
    { dimension: 'device', expressions: ['MOBILE'] },
  ]);
});

test('overview and compare send search_type; page-query stays query/web', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({
    rows: [{ keys: ['2026-03-01'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }],
  }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);

  await toolsOf(server).get_performance_overview!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    search_type: 'webMultimodal',
  }, {});
  assert.ok(calls.some((c) => c.type === 'webMultimodal'));

  await toolsOf(server).compare_search_periods!.executor({
    site_url: 'sc-domain:example.com',
    period1_start: '2026-03-01',
    period1_end: '2026-03-07',
    period2_start: '2026-02-01',
    period2_end: '2026-02-07',
    dimensions: 'page',
    search_type: 'image',
    limit: 10,
  }, {});
  assert.ok(calls.filter((c) => c.type === 'image').length >= 2);

  const beforePage = calls.length;
  await toolsOf(server).get_search_by_page_query!.executor({
    site_url: 'sc-domain:example.com',
    page_url: 'https://example.com/a',
    days: 7,
    row_limit: 20,
  }, {});
  const pageBody = calls[beforePage]!;
  assert.deepEqual(pageBody.dimensions, ['query']);
  assert.equal(pageBody.type, undefined);
});

test('hourly_all and metadata from the prior response shape are unchanged', async () => {
  const calls: Record<string, unknown>[] = [];
  const svc = harness(() => ({ rows: [] }), calls);
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const rejected = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor({
    ...ADVANCED,
    dimensions: 'query',
    data_state: 'hourly_all',
  }, {}));
  assert.match(String(rejected.error), /hourly_all/);
  assert.equal(calls.length, 0);
});

test('tool descriptions document the three capabilities without claiming isolated AI Overview fields', () => {
  const tools = toolsOf(buildMcpServer());
  assert.match(tools.get_search_analytics!.description ?? '', /webMultimodal/);
  assert.match(tools.get_search_analytics!.description ?? '', /not AI Overview or AI Mode/);
  assert.match(tools.get_advanced_search_analytics!.description ?? '', /filter_lists/);
  assert.match(tools.get_advanced_search_analytics!.description ?? '', /brandedClassification/);
  assert.match(tools.get_advanced_search_analytics!.description ?? '', /not AI Overview or AI Mode/);
  assert.match(tools.get_search_by_page_query!.description ?? '', /cannot return webMultimodal/);
  assert.match(tools.get_capabilities!.description ?? '', /no AI Overview \/ AI Mode data via API/);
});
