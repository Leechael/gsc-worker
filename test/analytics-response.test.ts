/**
 * Search analytics response shape:
 * - pass through responseAggregationType when present
 * - empty successes stay JSON and keep completeness fields the API sent
 * - do not invent incomplete dates
 * - firstIncompleteHour is an ISO-8601 string
 * - advanced tool descriptions document per-request limits, has_more, and filters
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';
import { parseConfig } from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerAdvancedAnalyticsTools } from '../src/tools/analytics-advanced.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

interface RegisteredTool {
  description?: string;
  inputSchema: ZodType;
  executor: (args: unknown, ctx: unknown) => Promise<ToolResult>;
}

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function harness(respond: (url: string, body: Record<string, unknown> | undefined) => unknown): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    return new Response(JSON.stringify(respond(url, body)), { status: 200 });
  }) as typeof fetch;
  return { config: parseConfig(), tokenProvider, gsc: new GscClient({ tokenProvider, fetchImpl }) };
}

const ADVANCED_ARGS = {
  site_url: 'sc-domain:example.com',
  dimensions: 'query',
  search_type: 'web',
  row_limit: 20,
  start_row: 0,
  sort_by: 'clicks',
  sort_direction: 'descending',
  filter_operator: 'contains',
};

const ISO_HOUR = '2026-11-08T10:00:00-08:00';

function parseJson(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('advanced analytics keeps aggregation type and ISO hour metadata', async () => {
  const svc = harness(() => ({
    rows: [{ keys: ['brand'], clicks: 4, impressions: 10, ctr: 0.4, position: 2 }],
    responseAggregationType: 'byProperty',
    metadata: { firstIncompleteHour: ISO_HOUR },
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const body = parseJson(await toolsOf(server).get_advanced_search_analytics!.executor(ADVANCED_ARGS, {}));
  assert.equal(body.response_aggregation_type, 'byProperty');
  const metadata = body.metadata as { first_incomplete_hour: string; first_incomplete_date?: string };
  assert.equal(metadata.first_incomplete_hour, ISO_HOUR);
  assert.equal(metadata.first_incomplete_date, undefined);
  assert.equal(typeof metadata.first_incomplete_hour, 'string');
});

test('empty advanced analytics stays JSON and does not invent completeness fields', async () => {
  const withFields = harness(() => ({
    rows: [],
    responseAggregationType: 'byPage',
    metadata: { firstIncompleteDate: '2026-11-08', firstIncompleteHour: ISO_HOUR },
  }));
  const withServer = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(withServer, withFields);
  const kept = parseJson(await toolsOf(withServer).get_advanced_search_analytics!.executor(ADVANCED_ARGS, {}));
  assert.equal(kept.row_count, 0);
  assert.deepEqual(kept.rows, []);
  assert.equal(kept.response_aggregation_type, 'byPage');
  const keptMeta = kept.metadata as { first_incomplete_date: string; first_incomplete_hour: string };
  assert.equal(keptMeta.first_incomplete_date, '2026-11-08');
  assert.equal(keptMeta.first_incomplete_hour, ISO_HOUR);

  const bare = harness(() => ({ rows: [] }));
  const bareServer = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(bareServer, bare);
  const omitted = parseJson(await toolsOf(bareServer).get_advanced_search_analytics!.executor(ADVANCED_ARGS, {}));
  assert.equal(omitted.row_count, 0);
  assert.equal('metadata' in omitted, false);
  assert.equal('response_aggregation_type' in omitted, false);
  assert.equal('first_incomplete_date' in omitted, false);
});

test('basic analytics empty and success paths pass through aggregation type', async () => {
  const svc = harness(() => ({
    rows: [],
    responseAggregationType: 'auto',
    metadata: { firstIncompleteDate: '2026-11-08' },
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAnalyticsTools(server, svc);
  const empty = parseJson(await toolsOf(server).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    dimensions: 'date',
    row_limit: 20,
  }, {}));
  assert.equal(empty.row_count, 0);
  assert.equal(empty.response_aggregation_type, 'auto');
  assert.equal((empty.metadata as { first_incomplete_date: string }).first_incomplete_date, '2026-11-08');

  const filled = harness(() => ({
    rows: [{ keys: ['2026-11-01'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }],
    responseAggregationType: 'byProperty',
  }));
  const filledServer = new McpServer({ name: 't', version: '0' });
  registerAnalyticsTools(filledServer, filled);
  const ok = parseJson(await toolsOf(filledServer).get_search_analytics!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
    dimensions: 'date',
    row_limit: 20,
  }, {}));
  assert.equal(ok.response_aggregation_type, 'byProperty');
  assert.equal('metadata' in ok, false);
});

test('overview empty success is JSON and uses trend completeness fields', async () => {
  const svc = harness((_url, body) => {
    const dims = body?.dimensions as unknown[];
    if (Array.isArray(dims) && dims.length === 0) {
      return { rows: [], responseAggregationType: 'byProperty' };
    }
    return {
      rows: [],
      responseAggregationType: 'byPage',
      metadata: { firstIncompleteDate: '2026-11-08' },
    };
  });
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const empty = parseJson(await toolsOf(server).get_performance_overview!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
  }, {}));
  assert.equal(empty.totals, null);
  assert.deepEqual(empty.daily_trend, []);
  assert.match(String(empty.note), /No performance data available/);
  assert.equal(empty.response_aggregation_type, 'byPage');
  assert.equal((empty.metadata as { first_incomplete_date: string }).first_incomplete_date, '2026-11-08');

  const bare = harness(() => ({ rows: [] }));
  const bareServer = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(bareServer, bare);
  const omitted = parseJson(await toolsOf(bareServer).get_performance_overview!.executor({
    site_url: 'sc-domain:example.com',
    days: 7,
  }, {}));
  assert.equal(omitted.totals, null);
  assert.equal('metadata' in omitted, false);
  assert.equal('response_aggregation_type' in omitted, false);
});

test('compare empty success keeps per-period completeness fields', async () => {
  const svc = harness((_url, body) => ({
    rows: [],
    responseAggregationType: String(body?.startDate) === '2026-02-01' ? 'byPage' : 'byProperty',
    metadata: { firstIncompleteDate: String(body?.startDate) },
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const empty = parseJson(await toolsOf(server).compare_search_periods!.executor({
    site_url: 'sc-domain:example.com',
    period1_start: '2026-02-01',
    period1_end: '2026-02-28',
    period2_start: '2026-01-01',
    period2_end: '2026-01-31',
    dimensions: 'date',
    limit: 10,
  }, {}));
  assert.deepEqual(empty.comparison, []);
  assert.equal(empty.total_items, 0);
  assert.equal((empty.metadata_period1 as { first_incomplete_date: string }).first_incomplete_date, '2026-02-01');
  assert.equal((empty.metadata_period2 as { first_incomplete_date: string }).first_incomplete_date, '2026-01-01');
  assert.equal(empty.response_aggregation_type_period1, 'byPage');
  assert.equal(empty.response_aggregation_type_period2, 'byProperty');
});

test('page-query empty success stays JSON with API completeness fields', async () => {
  const svc = harness(() => ({
    rows: [],
    responseAggregationType: 'byPage',
    metadata: { firstIncompleteDate: '2026-11-08' },
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerAdvancedAnalyticsTools(server, svc);
  const empty = parseJson(await toolsOf(server).get_search_by_page_query!.executor({
    site_url: 'sc-domain:example.com',
    page_url: 'https://example.com/a',
    days: 7,
    row_limit: 20,
  }, {}));
  assert.equal(empty.row_count, 0);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.response_aggregation_type, 'byPage');
  assert.equal((empty.metadata as { first_incomplete_date: string }).first_incomplete_date, '2026-11-08');
  assert.match(String(empty.note), /No search data found for page/);
});

test('advanced tool descriptions document row limits, has_more, RE2, and expression length', () => {
  const tool = toolsOf(buildMcpServer()).get_advanced_search_analytics!;
  const description = tool.description ?? '';
  assert.match(description, /Each API request returns at most 25000 rows/);
  assert.match(description, /max 100000/);
  assert.match(description, /pagination\.has_more/);
  assert.match(description, /not a guarantee/);
  assert.doesNotMatch(description, /up to 25000 rows across pages/);
  assert.match(description, /RE2/);
  assert.match(description, /4096/);

  const json = tool.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
    properties: Record<string, { description?: string }>;
  };
  assert.match(json.properties.dimensions?.description ?? '', /searchAppearance/);
  assert.match(json.properties.dimensions?.description ?? '', /hour/);
  assert.match(json.properties.filter_operator?.description ?? '', /includingRegex/);
  assert.match(json.properties.filter_operator?.description ?? '', /RE2/);
  assert.match(json.properties.filter_operator?.description ?? '', /4096/);
  assert.match(json.properties.filters?.description ?? '', /RE2/);
  assert.match(json.properties.filters?.description ?? '', /4096/);
  assert.match(json.properties.filter_expression?.description ?? '', /4096/);
  assert.match(json.properties.row_limit?.description ?? '', /max 25000 per request/);
  assert.match(json.properties.max_rows?.description ?? '', /25000 rows/);
});
