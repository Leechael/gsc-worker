/**
 * Yandex Webmaster tools (yandex_*). Registered (via ./index.ts) only when
 * YANDEX_OAUTH_TOKEN is set. Read tools work at every scope tier; yandex_add_sitemap and
 * yandex_recrawl_url need the write tier (GSC_SCOPES=full), and
 * yandex_delete_sitemap needs the destructive tier (plus
 * GSC_ALLOW_DESTRUCTIVE=true), using the same tier order as the Google tools.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ScopeTier } from '../../lib/config.js';
import type { ServerServices } from '../../mcp/context.js';
import { errorResult, jsonResult } from '../../tools/helpers.js';
import { engineTierGate, type EngineToolInfo } from '../types.js';
import {
  YandexApiError,
  YandexWebmasterClient,
  normalizeYandexDate,
  pathSegment,
  type YandexClientOptions,
  type YandexHost,
} from './client.js';

export const YANDEX_LABEL = 'Yandex Webmaster';

const TOKEN_HELP =
  'Get a new token: create an app at https://oauth.yandex.com/client/new/ (For API access or debugging; webmaster:hostinfo and webmaster:verify), ' +
  'open https://oauth.yandex.com/authorize?response_type=token&client_id=<ClientID>, then set it with `npx wrangler secret put YANDEX_OAUTH_TOKEN` ' +
  '(or the YANDEX_OAUTH_TOKEN env var on Node). Tokens last about 6 months. See README, "Yandex Webmaster".';

/** Tools and the tier each needs, for get_capabilities and the README. */
export const YANDEX_TOOLS: readonly EngineToolInfo[] = [
  { name: 'yandex_list_hosts', tier: 'read', summary: 'Sites in the Yandex Webmaster account with host_id and verification (GET hosts)' },
  { name: 'yandex_get_host', tier: 'read', summary: 'Site information and indexing status (GET hosts/{host-id})' },
  { name: 'yandex_get_host_summary', tier: 'read', summary: 'SQI, pages in search, excluded pages, problems by severity (summary)' },
  { name: 'yandex_get_popular_queries', tier: 'read', summary: 'Top queries with shows, clicks, positions (search-queries/popular)' },
  { name: 'yandex_get_queries_history', tier: 'read', summary: 'Daily indicators over all queries (search-queries/all/history)' },
  { name: 'yandex_get_query_history', tier: 'read', summary: 'Daily indicators for one query (search-queries/{query-id}/history)' },
  { name: 'yandex_get_indexing_history', tier: 'read', summary: 'Downloaded pages by HTTP status over time (indexing/history)' },
  { name: 'yandex_get_indexing_samples', tier: 'read', summary: 'Examples of downloaded pages (indexing/samples)' },
  { name: 'yandex_get_in_search_history', tier: 'read', summary: 'Pages in search over time (search-urls/in-search/history)' },
  { name: 'yandex_get_in_search_samples', tier: 'read', summary: 'Pages in search (search-urls/in-search/samples)' },
  { name: 'yandex_get_search_events_history', tier: 'read', summary: 'Pages added to / removed from search over time (search-urls/events/history)' },
  { name: 'yandex_get_search_events_samples', tier: 'read', summary: 'Pages added to / removed from search, with reasons (search-urls/events/samples)' },
  { name: 'yandex_get_diagnostics', tier: 'read', summary: 'Site problems with severity and state (diagnostics)' },
  { name: 'yandex_get_sqi_history', tier: 'read', summary: 'Site quality index history (sqi-history)' },
  { name: 'yandex_get_broken_internal_links', tier: 'read', summary: 'Examples of broken internal links (links/internal/broken/samples)' },
  { name: 'yandex_get_broken_internal_links_history', tier: 'read', summary: 'Broken internal links over time (links/internal/broken/history)' },
  { name: 'yandex_get_external_links', tier: 'read', summary: 'Examples of external links to the site (links/external/samples)' },
  { name: 'yandex_get_external_links_history', tier: 'read', summary: 'External link count over time (links/external/history)' },
  { name: 'yandex_list_sitemaps', tier: 'read', summary: 'Sitemaps known to Yandex (sitemaps)' },
  { name: 'yandex_get_sitemap', tier: 'read', summary: 'One sitemap (sitemaps/{sitemap-id})' },
  { name: 'yandex_list_user_sitemaps', tier: 'read', summary: 'Sitemaps added in Yandex Webmaster (user-added-sitemaps)' },
  { name: 'yandex_get_recrawl_quota', tier: 'read', summary: 'Daily recrawl quota and remainder (recrawl/quota)' },
  { name: 'yandex_list_recrawl_tasks', tier: 'read', summary: 'Recrawl requests and their state (recrawl/queue)' },
  { name: 'yandex_get_recrawl_task', tier: 'read', summary: 'State of one recrawl request (recrawl/queue/{task-id})' },
  { name: 'yandex_add_sitemap', tier: 'write', summary: 'Add a sitemap URL (POST user-added-sitemaps)' },
  { name: 'yandex_recrawl_url', tier: 'write', summary: 'Send a URL for recrawl; uses the daily quota (POST recrawl/queue)' },
  { name: 'yandex_delete_sitemap', tier: 'destructive', summary: 'Remove a sitemap added in Webmaster (DELETE user-added-sitemaps/{sitemap-id})' },
];

const yandexGate = (tier: ScopeTier, tool: string, required: 'write' | 'destructive') => engineTierGate(tier, tool, required, YANDEX_LABEL);

/** Friendly message for a failed Yandex call. Never contains the token. */
export function yandexErrorText(prefix: string, e: unknown): string {
  if (e instanceof YandexApiError) {
    const code = e.code ? ` ${e.code}` : '';
    if (e.status === 401 || e.code === 'INVALID_OAUTH_TOKEN') {
      return `Error: Yandex rejected YANDEX_OAUTH_TOKEN (HTTP ${e.status}${code}): it is missing, invalid, revoked, or expired. ${TOKEN_HELP}`;
    }
    if (e.status === 429) {
      const quota = e.dailyQuota != null ? ` Daily quota: ${e.dailyQuota}.` : '';
      const until = e.exceededUntil ? ` The new quota starts at ${normalizeYandexDate(e.exceededUntil)}.` : ' Try again later.';
      return `Error: Yandex Webmaster quota exceeded while ${prefix} (HTTP 429${code}).${quota}${until} Details: ${e.message}`;
    }
    if (e.status === 403) {
      const hint = e.code === 'ACCESS_FORBIDDEN'
        ? ' The OAuth app behind the token lacks the needed permission (webmaster:hostinfo, plus webmaster:verify for changes).'
        : '';
      return `Error: Yandex Webmaster denied access while ${prefix} (HTTP 403${code}).${hint} Details: ${e.message}`;
    }
    if (e.status === 0) return `Error: ${prefix}: ${e.message}`;
    return `Error: ${prefix}: ${e.message} (HTTP ${e.status}${code})`;
  }
  return `Error: ${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------- normalization ----------

interface Point { date?: string; value?: number | string }
interface IndicatorHistory { indicators?: Record<string, Point[]> }

function points(list: Point[] | undefined): { date: string | null; value: number | string | null }[] {
  return (list ?? []).map((p) => ({ date: normalizeYandexDate(p.date), value: p.value ?? null }));
}

function indicatorHistory(data: IndicatorHistory | undefined): Record<string, { date: string | null; value: number | string | null }[]> {
  const out: Record<string, { date: string | null; value: number | string | null }[]> = {};
  for (const [k, v] of Object.entries(data?.indicators ?? {})) out[k] = points(v);
  return out;
}

function host(h: YandexHost) {
  return {
    host_id: h.host_id,
    url: h.ascii_host_url ?? null,
    unicode_url: h.unicode_host_url ?? null,
    verified: h.verified ?? null,
    main_mirror: h.main_mirror?.host_id
      ? { host_id: h.main_mirror.host_id, url: h.main_mirror.ascii_host_url ?? null, verified: h.main_mirror.verified ?? null }
      : null,
  };
}

function withDates<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (k in out) out[k] = normalizeYandexDate(out[k]);
  return out as T;
}

// ---------- schemas ----------

const hostArg = z.string().min(1).describe(
  'Yandex host_id from yandex_list_hosts (e.g. https:example.com:443), or the exact site URL as listed there (e.g. https://example.com/).',
);
const dateArg = (what: string) => z.string().nullish().describe(
  `${what} of the range: YYYY-MM-DD or an ISO 8601 date-time; passed to Yandex as date_${what === 'Start' ? 'from' : 'to'}. Omit for the Yandex default.`,
);
const offsetArg = z.number().int().min(0).nullish().describe('List offset (minimum 0).');
const limitArg = (max: number, def: number) => z.number().int().min(1).max(max).nullish().describe(`Page size (1-${max}); Yandex default ${def}.`);
const QUERY_INDICATORS = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'] as const;
const DEVICES = ['ALL', 'DESKTOP', 'MOBILE_AND_TABLET', 'MOBILE', 'TABLET'] as const;
const indicatorsArg = z.array(z.enum(QUERY_INDICATORS)).min(1).nullish().describe(
  'Indicators to return (query_indicator, repeatable): TOTAL_SHOWS, TOTAL_CLICKS, AVG_SHOW_POSITION, AVG_CLICK_POSITION.',
);
const deviceArg = z.enum(DEVICES).nullish().describe('device_type_indicator; Yandex default ALL.');

type ToolResult = Awaited<ReturnType<typeof jsonResult>> | ReturnType<typeof errorResult>;

/**
 * Register the yandex_* tools. One client per MCP server instance (per request
 * on HTTP), so user_id and the host list are cached for that lifetime only.
 */
export function registerYandexTools(server: McpServer, svc: ServerServices, clientOptions: YandexClientOptions): void {
  const client = new YandexWebmasterClient(clientOptions);

  const run = async (prefix: string, fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return jsonResult(await fn());
    } catch (e) {
      return errorResult(yandexErrorText(prefix, e));
    }
  };

  server.registerTool(
    'yandex_list_hosts',
    {
      title: 'Yandex: list sites',
      description: 'List the sites in the Yandex Webmaster account with their host_id (needed by the other yandex_* tools), verification state and main mirror.',
      inputSchema: z.object({}),
    },
    async () => run('listing Yandex sites', async () => {
      const hosts = await client.listHosts();
      return { user_id: await client.userId(), count: hosts.length, hosts: hosts.map(host) };
    }),
  );

  server.registerTool(
    'yandex_get_host',
    {
      title: 'Yandex: site information',
      description: 'Site information from Yandex Webmaster: URLs, verification, main mirror, host_data_status (NOT_INDEXED, NOT_LOADED, OK) and display name.',
      inputSchema: z.object({ host: hostArg }),
    },
    async ({ host: h }) => run('getting Yandex site information', async () => {
      const d = await client.hostRequest<YandexHost & { host_data_status?: string; host_display_name?: string }>(h, '');
      return { ...host(d), host_data_status: d.host_data_status ?? null, host_display_name: d.host_display_name ?? null };
    }),
  );

  server.registerTool(
    'yandex_get_host_summary',
    {
      title: 'Yandex: site statistics',
      description: 'Site summary: SQI (site quality index), pages in search, excluded pages, and site problems grouped by severity (FATAL, CRITICAL, POSSIBLE_PROBLEM, RECOMMENDATION).',
      inputSchema: z.object({ host: hostArg }),
    },
    async ({ host: h }) => run('getting the Yandex site summary', async () => {
      const d = await client.hostRequest<{ sqi?: number; searchable_pages_count?: number; excluded_pages_count?: number; site_problems?: Record<string, number> }>(h, '/summary');
      return {
        sqi: d.sqi ?? null,
        searchable_pages_count: d.searchable_pages_count ?? null,
        excluded_pages_count: d.excluded_pages_count ?? null,
        site_problems: d.site_problems ?? {},
      };
    }),
  );

  server.registerTool(
    'yandex_get_popular_queries',
    {
      title: 'Yandex: popular search queries',
      description:
        'Top search queries the site was shown for in Yandex (from the TOP-3000; last week unless dates are given), ordered by shows or clicks. ' +
        'Returns query_id (for yandex_get_query_history), query text and the requested indicators.',
      inputSchema: z.object({
        host: hostArg,
        order_by: z.enum(['TOTAL_SHOWS', 'TOTAL_CLICKS']).describe('Sort order (required by Yandex).'),
        query_indicators: indicatorsArg,
        device_type: deviceArg,
        date_from: dateArg('Start'),
        date_to: dateArg('End'),
        offset: offsetArg,
        limit: limitArg(500, 500),
      }),
    },
    async (a) => run('getting Yandex popular queries', async () => {
      const d = await client.hostRequest<{ queries?: { query_id?: string; query_text?: string; indicators?: Record<string, number> }[]; date_from?: string; date_to?: string; count?: number | string }>(a.host, '/search-queries/popular', {
        query: {
          order_by: a.order_by,
          query_indicator: a.query_indicators ?? undefined,
          device_type_indicator: a.device_type,
          date_from: a.date_from,
          date_to: a.date_to,
          offset: a.offset,
          limit: a.limit,
        },
      });
      return {
        date_from: d.date_from ?? null,
        date_to: d.date_to ?? null,
        total_count: d.count != null ? Number(d.count) : null,
        queries: (d.queries ?? []).map((q) => ({ query_id: q.query_id ?? null, query_text: q.query_text ?? null, indicators: q.indicators ?? {} })),
      };
    }),
  );

  server.registerTool(
    'yandex_get_queries_history',
    {
      title: 'Yandex: history for all queries',
      description: 'Daily history of indicators summed over all search queries (shows, clicks, average positions). Last week unless dates are given.',
      inputSchema: z.object({ host: hostArg, query_indicators: indicatorsArg, device_type: deviceArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex query history', async () => {
      const d = await client.hostRequest<IndicatorHistory>(a.host, '/search-queries/all/history', {
        query: { query_indicator: a.query_indicators ?? undefined, device_type_indicator: a.device_type, date_from: a.date_from, date_to: a.date_to },
      });
      return { indicators: indicatorHistory(d) };
    }),
  );

  server.registerTool(
    'yandex_get_query_history',
    {
      title: 'Yandex: history for one query',
      description: 'Daily indicator history for one search query, by query_id from yandex_get_popular_queries. Last week unless dates are given.',
      inputSchema: z.object({
        host: hostArg,
        query_id: z.string().min(1).describe('query_id from yandex_get_popular_queries.'),
        query_indicators: indicatorsArg,
        device_type: deviceArg,
        date_from: dateArg('Start'),
        date_to: dateArg('End'),
      }),
    },
    async (a) => run('getting Yandex history for the query', async () => {
      const d = await client.hostRequest<{ query_id?: string; query_text?: string; indicators?: Record<string, Point[]>; queries?: { query_id?: string; query_text?: string; indicators?: Record<string, Point[]> }[] }>(
        a.host,
        `/search-queries/${pathSegment(a.query_id)}/history`,
        { query: { query_indicator: a.query_indicators ?? undefined, device_type_indicator: a.device_type, date_from: a.date_from, date_to: a.date_to } },
      );
      // The documented example nests the result under `queries`, the field table lists it flat; accept both.
      const q = d.queries?.[0] ?? d;
      return { query_id: q.query_id ?? a.query_id, query_text: q.query_text ?? null, indicators: indicatorHistory(q) };
    }),
  );

  server.registerTool(
    'yandex_get_indexing_history',
    {
      title: 'Yandex: crawl (indexing) history',
      description: 'Pages downloaded by the Yandex robot over time, grouped by HTTP status class (HTTP_2XX, HTTP_3XX, HTTP_4XX, HTTP_5XX, OTHER). Current day unless dates are given.',
      inputSchema: z.object({ host: hostArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex indexing history', async () => ({
      indicators: indicatorHistory(await client.hostRequest<IndicatorHistory>(a.host, '/indexing/history', { query: { date_from: a.date_from, date_to: a.date_to } })),
    })),
  );

  server.registerTool(
    'yandex_get_indexing_samples',
    {
      title: 'Yandex: downloaded page samples',
      description: 'Examples of pages the Yandex robot downloaded (up to 50,000 URLs), with status, HTTP code and crawl date.',
      inputSchema: z.object({ host: hostArg, offset: offsetArg, limit: limitArg(100, 50) }),
    },
    async (a) => run('getting Yandex indexing samples', async () => {
      const d = await client.hostRequest<{ count?: number; samples?: Record<string, unknown>[] }>(a.host, '/indexing/samples', { query: { offset: a.offset, limit: a.limit } });
      return { count: d.count ?? null, samples: (d.samples ?? []).map((s) => withDates(s, ['access_date'])) };
    }),
  );

  server.registerTool(
    'yandex_get_in_search_history',
    {
      title: 'Yandex: pages in search over time',
      description: 'Number of the site\'s pages in Yandex search results over time. Current day unless dates are given.',
      inputSchema: z.object({ host: hostArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex pages-in-search history', async () => {
      const d = await client.hostRequest<{ history?: Point[] }>(a.host, '/search-urls/in-search/history', { query: { date_from: a.date_from, date_to: a.date_to } });
      return { history: points(d.history) };
    }),
  );

  server.registerTool(
    'yandex_get_in_search_samples',
    {
      title: 'Yandex: pages in search',
      description: 'URLs of pages included in Yandex search results (up to 50,000), with title and the date of the version in search.',
      inputSchema: z.object({ host: hostArg, offset: offsetArg, limit: limitArg(100, 50) }),
    },
    async (a) => run('getting Yandex pages in search', async () => {
      const d = await client.hostRequest<{ count?: number; samples?: Record<string, unknown>[] }>(a.host, '/search-urls/in-search/samples', { query: { offset: a.offset, limit: a.limit } });
      return { count: d.count ?? null, samples: (d.samples ?? []).map((s) => withDates(s, ['last_access'])) };
    }),
  );

  server.registerTool(
    'yandex_get_search_events_history',
    {
      title: 'Yandex: pages added to / removed from search over time',
      description: 'Counts of pages that appeared in (APPEARED_IN_SEARCH) or were removed from (REMOVED_FROM_SEARCH) Yandex search over time. Current day unless dates are given.',
      inputSchema: z.object({ host: hostArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex search events history', async () => ({
      indicators: indicatorHistory(await client.hostRequest<IndicatorHistory>(a.host, '/search-urls/events/history', { query: { date_from: a.date_from, date_to: a.date_to } })),
    })),
  );

  server.registerTool(
    'yandex_get_search_events_samples',
    {
      title: 'Yandex: pages added to / removed from search',
      description: 'Examples of pages that appeared in or were removed from Yandex search (up to 50,000), with the exclusion reason (excluded_url_status) and target_url for redirects, canonicals and duplicates.',
      inputSchema: z.object({ host: hostArg, offset: offsetArg, limit: limitArg(100, 50) }),
    },
    async (a) => run('getting Yandex search events', async () => {
      const d = await client.hostRequest<{ count?: number; samples?: Record<string, unknown>[] }>(a.host, '/search-urls/events/samples', { query: { offset: a.offset, limit: a.limit } });
      return { count: d.count ?? null, samples: (d.samples ?? []).map((s) => withDates(s, ['event_date', 'last_access'])) };
    }),
  );

  server.registerTool(
    'yandex_get_diagnostics',
    {
      title: 'Yandex: site diagnostics',
      description: 'Site problems found by Yandex (e.g. NO_SITEMAPS, SSL_CERTIFICATE_ERROR) with severity, state (PRESENT, ABSENT, UNDEFINED) and last state change. Present problems are listed first.',
      inputSchema: z.object({ host: hostArg, only_present: z.boolean().nullish().describe('Only return problems in state PRESENT (default false).') }),
    },
    async (a) => run('getting Yandex diagnostics', async () => {
      const d = await client.hostRequest<{ problems?: Record<string, { severity?: string; state?: string; last_state_update?: string }> }>(a.host, '/diagnostics');
      const order = ['FATAL', 'CRITICAL', 'POSSIBLE_PROBLEM', 'RECOMMENDATION'];
      let problems = Object.entries(d.problems ?? {}).map(([type, p]) => ({
        type,
        severity: p.severity ?? null,
        state: p.state ?? null,
        last_state_update: normalizeYandexDate(p.last_state_update),
      }));
      if (a.only_present) problems = problems.filter((p) => p.state === 'PRESENT');
      problems.sort((x, y) =>
        Number(y.state === 'PRESENT') - Number(x.state === 'PRESENT') ||
        (order.indexOf(x.severity ?? '') + 1 || 99) - (order.indexOf(y.severity ?? '') + 1 || 99),
      );
      return { present_count: problems.filter((p) => p.state === 'PRESENT').length, problems };
    }),
  );

  server.registerTool(
    'yandex_get_sqi_history',
    {
      title: 'Yandex: SQI history',
      description: 'History of the site quality index (SQI) over the past year.',
      inputSchema: z.object({ host: hostArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex SQI history', async () => {
      const d = await client.hostRequest<{ points?: Point[] }>(a.host, '/sqi-history', { query: { date_from: a.date_from, date_to: a.date_to } });
      return { points: points(d.points) };
    }),
  );

  const BROKEN = ['SITE_ERROR', 'DISALLOWED_BY_USER', 'UNSUPPORTED_BY_ROBOT'] as const;
  server.registerTool(
    'yandex_get_broken_internal_links',
    {
      title: 'Yandex: broken internal links',
      description: 'Examples of broken internal links (source and destination URL, discovery date), optionally filtered by reason.',
      inputSchema: z.object({
        host: hostArg,
        indicators: z.array(z.enum(BROKEN)).min(1).nullish().describe('Reasons to include (indicator, repeatable): SITE_ERROR, DISALLOWED_BY_USER, UNSUPPORTED_BY_ROBOT. Omit for all.'),
        offset: offsetArg,
        limit: limitArg(100, 10),
      }),
    },
    async (a) => run('getting Yandex broken internal links', async () => {
      const d = await client.hostRequest<{ count?: number; links?: Record<string, unknown>[] }>(a.host, '/links/internal/broken/samples', {
        query: { indicator: a.indicators ?? undefined, offset: a.offset, limit: a.limit },
      });
      return { count: d.count ?? null, links: d.links ?? [] };
    }),
  );

  server.registerTool(
    'yandex_get_broken_internal_links_history',
    {
      title: 'Yandex: broken internal links over time',
      description: 'History of the number of broken internal links, per reason. Current day unless dates are given.',
      inputSchema: z.object({ host: hostArg, date_from: dateArg('Start'), date_to: dateArg('End') }),
    },
    async (a) => run('getting Yandex broken link history', async () => ({
      indicators: indicatorHistory(await client.hostRequest<IndicatorHistory>(a.host, '/links/internal/broken/history', { query: { date_from: a.date_from, date_to: a.date_to } })),
    })),
  );

  server.registerTool(
    'yandex_get_external_links',
    {
      title: 'Yandex: external links',
      description: 'Examples of external links pointing to the site (source and destination URL, discovery date).',
      inputSchema: z.object({ host: hostArg, offset: offsetArg, limit: limitArg(100, 10) }),
    },
    async (a) => run('getting Yandex external links', async () => {
      const d = await client.hostRequest<{ count?: number; links?: Record<string, unknown>[] }>(a.host, '/links/external/samples', { query: { offset: a.offset, limit: a.limit } });
      return { count: d.count ?? null, links: d.links ?? [] };
    }),
  );

  server.registerTool(
    'yandex_get_external_links_history',
    {
      title: 'Yandex: external links over time',
      description: 'History of the total number of known external links to the site (indicator LINKS_TOTAL_COUNT).',
      inputSchema: z.object({ host: hostArg }),
    },
    async (a) => run('getting Yandex external link history', async () => ({
      indicators: indicatorHistory(await client.hostRequest<IndicatorHistory>(a.host, '/links/external/history', { query: { indicator: 'LINKS_TOTAL_COUNT' } })),
    })),
  );

  type Sitemap = { sitemap_id?: string; sitemap_url?: string; last_access_date?: string; errors_count?: number; urls_count?: number; children_count?: number; sources?: string[]; source?: string[]; sitemap_type?: string };
  const sitemap = (s: Sitemap) => ({
    sitemap_id: s.sitemap_id ?? null,
    sitemap_url: s.sitemap_url ?? null,
    sitemap_type: s.sitemap_type ?? null,
    last_access_date: normalizeYandexDate(s.last_access_date),
    urls_count: s.urls_count ?? null,
    errors_count: s.errors_count ?? null,
    children_count: s.children_count ?? null,
    sources: s.sources ?? s.source ?? [],
  });
  const sitemapIdArg = z.string().min(1).describe('sitemap_id from yandex_list_sitemaps or yandex_list_user_sitemaps.');

  server.registerTool(
    'yandex_list_sitemaps',
    {
      title: 'Yandex: sitemaps',
      description: 'Sitemap files Yandex knows for the site (from robots.txt, Yandex Webmaster, or sitemap indexes), with URL and error counts. Use parent_id to list the children of a sitemap index and from for paging.',
      inputSchema: z.object({
        host: hostArg,
        parent_id: z.string().nullish().describe('List the children of this sitemap index (sitemap_id).'),
        limit: limitArg(100, 10),
        from: z.string().nullish().describe('Return sitemaps after this sitemap_id (paging).'),
      }),
    },
    async (a) => run('listing Yandex sitemaps', async () => {
      const d = await client.hostRequest<{ sitemaps?: Sitemap[] }>(a.host, '/sitemaps', { query: { parent_id: a.parent_id, limit: a.limit, from: a.from } });
      const list = (d.sitemaps ?? []).map(sitemap);
      return { count: list.length, sitemaps: list };
    }),
  );

  server.registerTool(
    'yandex_get_sitemap',
    {
      title: 'Yandex: sitemap details',
      description: 'Details for one sitemap file: type, last download, URL count, error count, child count and sources.',
      inputSchema: z.object({ host: hostArg, sitemap_id: sitemapIdArg }),
    },
    async (a) => run('getting the Yandex sitemap', async () => sitemap(await client.hostRequest<Sitemap>(a.host, `/sitemaps/${pathSegment(a.sitemap_id)}`))),
  );

  server.registerTool(
    'yandex_list_user_sitemaps',
    {
      title: 'Yandex: sitemaps added in Webmaster',
      description: 'Sitemap files added by the user in Yandex Webmaster (the ones yandex_delete_sitemap can remove).',
      inputSchema: z.object({
        host: hostArg,
        offset: z.string().nullish().describe('Return sitemaps after this sitemap_id (paging).'),
        limit: limitArg(100, 100),
      }),
    },
    async (a) => run('listing Yandex user-added sitemaps', async () => {
      const d = await client.hostRequest<{ sitemaps?: { sitemap_id?: string; sitemap_url?: string; added_date?: string }[]; count?: number }>(a.host, '/user-added-sitemaps', { query: { offset: a.offset, limit: a.limit } });
      return {
        count: d.count ?? null,
        sitemaps: (d.sitemaps ?? []).map((s) => ({ sitemap_id: s.sitemap_id ?? null, sitemap_url: s.sitemap_url ?? null, added_date: normalizeYandexDate(s.added_date) })),
      };
    }),
  );

  server.registerTool(
    'yandex_get_recrawl_quota',
    {
      title: 'Yandex: recrawl quota',
      description: 'Daily quota for sending pages to Yandex for recrawling, and how much of it is left.',
      inputSchema: z.object({ host: hostArg }),
    },
    async (a) => run('getting the Yandex recrawl quota', async () => {
      const d = await client.hostRequest<{ daily_quota?: number; quota_remainder?: number }>(a.host, '/recrawl/quota');
      return { daily_quota: d.daily_quota ?? null, quota_remainder: d.quota_remainder ?? null };
    }),
  );

  type Task = { task_id?: string; url?: string; added_time?: string; state?: string };
  const task = (t: Task) => ({ task_id: t.task_id ?? null, url: t.url ?? null, added_time: normalizeYandexDate(t.added_time), state: t.state ?? null });

  server.registerTool(
    'yandex_list_recrawl_tasks',
    {
      title: 'Yandex: recrawl tasks',
      description: 'Recrawl requests for the site with their state (IN_PROGRESS, DONE, FAILED).',
      inputSchema: z.object({
        host: hostArg,
        offset: offsetArg,
        limit: z.number().int().min(1).nullish().describe('Page size (minimum 1); Yandex default 50.'),
        date_from: dateArg('Start'),
        date_to: dateArg('End'),
      }),
    },
    async (a) => run('listing Yandex recrawl tasks', async () => {
      const d = await client.hostRequest<{ tasks?: Task[] }>(a.host, '/recrawl/queue', { query: { offset: a.offset, limit: a.limit, date_from: a.date_from, date_to: a.date_to } });
      const tasks = (d.tasks ?? []).map(task);
      return { count: tasks.length, tasks };
    }),
  );

  server.registerTool(
    'yandex_get_recrawl_task',
    {
      title: 'Yandex: recrawl task status',
      description: 'State of one recrawl request (IN_PROGRESS, DONE, FAILED) by task_id from yandex_recrawl_url or yandex_list_recrawl_tasks.',
      inputSchema: z.object({ host: hostArg, task_id: z.string().min(1).describe('task_id of the recrawl request.') }),
    },
    async (a) => run('getting the Yandex recrawl task', async () => task(await client.hostRequest<Task>(a.host, `/recrawl/queue/${pathSegment(a.task_id)}`))),
  );

  // ---------- write tier ----------

  server.registerTool(
    'yandex_add_sitemap',
    {
      title: 'Yandex: add a sitemap',
      description: 'Add a sitemap file URL to the site in Yandex Webmaster. Requires the write tier (GSC_SCOPES=full).',
      inputSchema: z.object({ host: hostArg, sitemap_url: z.string().url().describe('Absolute URL of the sitemap file.') }),
    },
    async (a) => {
      const gate = yandexGate(svc.config.scopeTier, 'yandex_add_sitemap', 'write');
      if (gate) return errorResult(gate);
      return run('adding the Yandex sitemap', async () => {
        const d = await client.hostRequest<{ sitemap_id?: string }>(a.host, '/user-added-sitemaps', { method: 'POST', body: { url: a.sitemap_url } });
        return { added: true, sitemap_url: a.sitemap_url, sitemap_id: d?.sitemap_id ?? null };
      });
    },
  );

  server.registerTool(
    'yandex_recrawl_url',
    {
      title: 'Yandex: send a page for recrawl',
      description:
        'Send one URL of the site to the Yandex recrawl queue. Uses the per-site daily quota (see yandex_get_recrawl_quota); returns task_id and quota_remainder. ' +
        'Requires the write tier (GSC_SCOPES=full).',
      inputSchema: z.object({ host: hostArg, url: z.string().url().describe('Absolute URL of a page on this site.') }),
    },
    async (a) => {
      const gate = yandexGate(svc.config.scopeTier, 'yandex_recrawl_url', 'write');
      if (gate) return errorResult(gate);
      return run('sending the URL to the Yandex recrawl queue', async () => {
        const d = await client.hostRequest<{ task_id?: string; quota_remainder?: number }>(a.host, '/recrawl/queue', { method: 'POST', body: { url: a.url } });
        return { queued: true, url: a.url, task_id: d?.task_id ?? null, quota_remainder: d?.quota_remainder ?? null };
      });
    },
  );

  // ---------- destructive tier ----------

  server.registerTool(
    'yandex_delete_sitemap',
    {
      title: 'Yandex: remove a sitemap',
      description:
        'Remove a sitemap that was added in Yandex Webmaster (sitemap_id from yandex_list_user_sitemaps). ' +
        'Requires the destructive tier (GSC_SCOPES=full and GSC_ALLOW_DESTRUCTIVE=true).',
      inputSchema: z.object({ host: hostArg, sitemap_id: sitemapIdArg }),
    },
    async (a) => {
      const gate = yandexGate(svc.config.scopeTier, 'yandex_delete_sitemap', 'destructive');
      if (gate) return errorResult(gate);
      return run('removing the Yandex sitemap', async () => {
        await client.hostRequest<void>(a.host, `/user-added-sitemaps/${pathSegment(a.sitemap_id)}`, { method: 'DELETE' });
        return { deleted: true, sitemap_id: a.sitemap_id };
      });
    },
  );
}
