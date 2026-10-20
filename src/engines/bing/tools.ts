/**
 * Bing Webmaster Tools MCP tools (bing_*). Registered only when BING_API_KEY
 * is set. Read tools always run; submit tools need the write tier
 * (GSC_SCOPES=full) and bing_remove_feed the destructive tier.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../../mcp/context.js';
import { errorResult, jsonResult } from '../../tools/helpers.js';
import { engineTierGate, parseHttpUrl, type EngineToolInfo } from '../types.js';
import { BingApiError, BingClient, bingDay, bingIso, decodeCrawlIssues, isCalendarDate } from './client.js';

export const BING_LABEL = 'Bing Webmaster Tools';
export const BING_SUBMIT_BATCH_MAX = 500;

export const BING_TOOLS: readonly EngineToolInfo[] = [
  { name: 'bing_list_sites', tier: 'read', summary: 'Sites in your Bing Webmaster Tools account (GetUserSites)' },
  { name: 'bing_get_query_stats', tier: 'read', summary: 'Top search queries: clicks, impressions, positions (GetQueryStats)' },
  { name: 'bing_get_page_stats', tier: 'read', summary: 'Top pages: clicks, impressions, positions (GetPageStats)' },
  { name: 'bing_get_traffic_stats', tier: 'read', summary: 'Daily clicks and impressions for the site (GetRankAndTrafficStats)' },
  { name: 'bing_get_crawl_stats', tier: 'read', summary: 'Daily crawl and index counts (GetCrawlStats)' },
  { name: 'bing_get_crawl_issues', tier: 'read', summary: 'URLs with crawl issues (GetCrawlIssues)' },
  { name: 'bing_get_url_info', tier: 'read', summary: 'Basic index/crawl info for one URL; not a URL inspection (GetUrlInfo)' },
  { name: 'bing_get_link_counts', tier: 'read', summary: 'Site pages with inbound link counts, paged (GetLinkCounts)' },
  { name: 'bing_get_feeds', tier: 'read', summary: 'Submitted sitemaps and feeds (GetFeeds)' },
  { name: 'bing_get_url_submission_quota', tier: 'read', summary: 'Remaining URL submission quota (GetUrlSubmissionQuota)' },
  { name: 'bing_submit_urls', tier: 'write', summary: `Submit up to ${BING_SUBMIT_BATCH_MAX} URLs for crawling (SubmitUrl / SubmitUrlBatch)` },
  { name: 'bing_submit_feed', tier: 'write', summary: 'Submit a sitemap or feed (SubmitFeed)' },
  { name: 'bing_remove_feed', tier: 'destructive', summary: 'Remove a submitted sitemap or feed (RemoveFeed)' },
];

const POSITION_NOTE =
  'Positions are returned as Bing reports them. Third-party reports say they may be scaled by 10 (e.g. 25 meaning 2.5); compare with the Bing Webmaster Tools UI before relying on them.';
const WINDOW_NOTE =
  'This Bing method takes no date range and returns a fixed recent window chosen by Bing; start_date/end_date only filter the returned rows. ' +
  'data_range spans the rows returned; source_window spans everything Bing sent.';

const siteUrlSchema = z
  .string()
  .min(1)
  .describe('Site URL exactly as registered in Bing Webmaster Tools (see bing_list_sites), e.g. "https://example.com/".');
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isCalendarDate, 'Use a real calendar date (YYYY-MM-DD)')
  .nullish();

/** Error text when start_date is after end_date, else null. */
function rangeError(start?: string | null, end?: string | null): string | null {
  return start && end && start > end ? `Error: start_date (${start}) is after end_date (${end}).` : null;
}
const rowLimitSchema = z.number().int().min(1).max(10000).nullish().describe('Maximum rows to return (default 100).');

interface RawQueryStats {
  Query?: string;
  Date?: string;
  Clicks?: number;
  Impressions?: number;
  AvgClickPosition?: number;
  AvgImpressionPosition?: number;
}
interface RawTraffic {
  Date?: string;
  Clicks?: number;
  Impressions?: number;
}
interface RawCrawlStats {
  Date?: string;
  CrawledPages?: number;
  CrawlErrors?: number;
  InIndex?: number;
  InLinks?: number;
  BlockedByRobotsTxt?: number;
  ContainsMalware?: number;
  Code2xx?: number;
  Code301?: number;
  Code302?: number;
  Code4xx?: number;
  Code5xx?: number;
  AllOtherCodes?: number;
}
interface RawCrawlIssue {
  Url?: string;
  HttpCode?: number;
  Issues?: number | string;
  InLinks?: number;
}
interface RawUrlInfo {
  Url?: string;
  HttpStatus?: number;
  DocumentSize?: number;
  AnchorCount?: number;
  TotalChildUrlCount?: number;
  IsPage?: boolean;
  DiscoveryDate?: string;
  LastCrawledDate?: string;
}
interface RawLinkCounts {
  Links?: { Url?: string; Count?: number }[];
  TotalPages?: number;
}
interface RawFeed {
  Url?: string;
  Type?: string;
  Status?: string;
  Submitted?: string;
  LastCrawled?: string;
  UrlCount?: number;
  FileSize?: number;
  Compressed?: boolean;
}
interface RawSite {
  Url?: string;
  IsVerified?: boolean;
}
interface RawQuota {
  DailyQuota?: number;
  MonthlyQuota?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ctr = (clicks: number, impressions: number): number | null =>
  impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : null;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function inRange(day: string | null, start?: string | null, end?: string | null): boolean {
  if (!day) return !start && !end;
  return (!start || day >= start) && (!end || day <= end);
}

function dateSpan(days: (string | null)[]): { first: string | null; last: string | null } {
  const sorted = days.filter((d): d is string => !!d).sort();
  return { first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null };
}

function fail(e: unknown) {
  if (e instanceof BingApiError) return errorResult(`Error: ${e.message}`);
  return errorResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
}

interface StatsArgs {
  site_url: string;
  start_date?: string | null | undefined;
  end_date?: string | null | undefined;
  row_limit?: number | null | undefined;
  sort_by?: 'clicks' | 'impressions' | null | undefined;
  aggregate?: boolean | null | undefined;
}

/** Shared by GetQueryStats (key = query) and GetPageStats (key = page URL, in the Query field). */
async function queryLikeStats(client: BingClient, method: 'GetQueryStats' | 'GetPageStats', keyName: 'query' | 'page', args: StatsArgs) {
  const raw = list<RawQueryStats>(await client.get<unknown>(method, { siteUrl: args.site_url }));
  const all = raw.map((r) => ({
    key: r.Query ?? '',
    date: bingDay(r.Date),
    clicks: num(r.Clicks),
    impressions: num(r.Impressions),
    avgClick: num(r.AvgClickPosition),
    avgImpr: num(r.AvgImpressionPosition),
  }));
  const rows = all.filter((r) => inRange(r.date, args.start_date, args.end_date));
  const aggregate = args.aggregate ?? true;
  const sortBy = args.sort_by ?? 'clicks';
  const limit = args.row_limit ?? 100;

  let out: Record<string, unknown>[];
  if (aggregate) {
    const groups = new Map<string, { clicks: number; impressions: number; wImpr: number; wClick: number; days: (string | null)[] }>();
    for (const r of rows) {
      const g = groups.get(r.key) ?? { clicks: 0, impressions: 0, wImpr: 0, wClick: 0, days: [] };
      g.clicks += r.clicks;
      g.impressions += r.impressions;
      g.wImpr += r.avgImpr * r.impressions;
      g.wClick += r.avgClick * r.clicks;
      g.days.push(r.date);
      groups.set(r.key, g);
    }
    out = [...groups.entries()].map(([key, g]) => {
      const span = dateSpan(g.days);
      return {
        [keyName]: key,
        clicks: g.clicks,
        impressions: g.impressions,
        ctr: ctr(g.clicks, g.impressions),
        avg_impression_position: g.impressions > 0 ? round2(g.wImpr / g.impressions) : null,
        avg_click_position: g.clicks > 0 ? round2(g.wClick / g.clicks) : null,
        first_date: span.first,
        last_date: span.last,
        periods: g.days.length,
      };
    });
  } else {
    out = rows.map((r) => ({
      [keyName]: r.key,
      date: r.date,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: ctr(r.clicks, r.impressions),
      avg_impression_position: r.avgImpr,
      avg_click_position: r.avgClick,
    }));
  }
  out.sort((a, b) => num(b[sortBy]) - num(a[sortBy]));

  return jsonResult({
    site_url: args.site_url,
    source: method,
    data_range: dateSpan(rows.map((r) => r.date)),
    source_window: dateSpan(all.map((r) => r.date)),
    filter: { start_date: args.start_date ?? null, end_date: args.end_date ?? null },
    aggregated: aggregate,
    total_rows: out.length,
    returned_rows: Math.min(limit, out.length),
    rows: out.slice(0, limit),
    notes: [WINDOW_NOTE, POSITION_NOTE],
  });
}

export function registerBingTools(server: McpServer, svc: ServerServices, client: BingClient): void {
  const tier = () => svc.config.scopeTier;

  server.registerTool(
    'bing_list_sites',
    {
      title: 'Bing: list sites',
      description: 'List the sites in the Bing Webmaster Tools account that owns BING_API_KEY, with verification status. Start here to get the exact site_url for other bing_* tools.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const sites = list<RawSite>(await client.get<unknown>('GetUserSites'));
        return jsonResult({
          count: sites.length,
          sites: sites.map((s) => ({ site_url: s.Url ?? null, is_verified: s.IsVerified ?? null })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const statsShape = {
    site_url: siteUrlSchema,
    start_date: dateSchema.describe('Optional YYYY-MM-DD; keep rows on or after this date (local filter).'),
    end_date: dateSchema.describe('Optional YYYY-MM-DD; keep rows on or before this date (local filter).'),
    row_limit: rowLimitSchema,
    sort_by: z.enum(['clicks', 'impressions']).nullish().describe('Sort descending by this metric (default clicks).'),
    aggregate: z
      .boolean()
      .nullish()
      .describe('Default true: sum each key across the weekly periods Bing returns. false: one row per key and period.'),
  };

  server.registerTool(
    'bing_get_query_stats',
    {
      title: 'Bing: query stats',
      description:
        'Top Bing search queries for a site with clicks, impressions, CTR and average positions (GetQueryStats). ' +
        'Bing returns a fixed recent window (no date-range parameter); dates are filtered locally.',
      inputSchema: z.object(statsShape),
    },
    async (args) => {
      const bad = rangeError(args.start_date, args.end_date);
      if (bad) return errorResult(bad);
      try {
        return await queryLikeStats(client, 'GetQueryStats', 'query', args);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_page_stats',
    {
      title: 'Bing: page stats',
      description:
        'Top pages of a site in Bing search with clicks, impressions, CTR and average positions (GetPageStats). ' +
        'Bing returns a fixed recent window (no date-range parameter); dates are filtered locally.',
      inputSchema: z.object(statsShape),
    },
    async (args) => {
      const bad = rangeError(args.start_date, args.end_date);
      if (bad) return errorResult(bad);
      try {
        return await queryLikeStats(client, 'GetPageStats', 'page', args);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_traffic_stats',
    {
      title: 'Bing: traffic stats',
      description:
        'Daily Bing clicks and impressions for the whole site (GetRankAndTrafficStats), oldest first, with totals. ' +
        'Bing includes all verticals (web, chat, news, images, videos, knowledge panel) from 2023-03-24 onwards.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        start_date: dateSchema.describe('Optional YYYY-MM-DD lower bound (local filter).'),
        end_date: dateSchema.describe('Optional YYYY-MM-DD upper bound (local filter).'),
      }),
    },
    async ({ site_url, start_date, end_date }) => {
      const bad = rangeError(start_date, end_date);
      if (bad) return errorResult(bad);
      try {
        const raw = list<RawTraffic>(await client.get<unknown>('GetRankAndTrafficStats', { siteUrl: site_url }));
        const all = raw.map((r) => ({ date: bingDay(r.Date), clicks: num(r.Clicks), impressions: num(r.Impressions) }));
        const rows = all
          .filter((r) => inRange(r.date, start_date, end_date))
          .sort((a, b) => String(a.date).localeCompare(String(b.date)))
          .map((r) => ({ ...r, ctr: ctr(r.clicks, r.impressions) }));
        const clicks = rows.reduce((s, r) => s + r.clicks, 0);
        const impressions = rows.reduce((s, r) => s + r.impressions, 0);
        return jsonResult({
          site_url,
          source: 'GetRankAndTrafficStats',
          data_range: dateSpan(rows.map((r) => r.date)),
          source_window: dateSpan(all.map((r) => r.date)),
          totals: { clicks, impressions, ctr: ctr(clicks, impressions) },
          days: rows.length,
          rows,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_crawl_stats',
    {
      title: 'Bing: crawl stats',
      description: 'Daily Bingbot crawl statistics for a site (GetCrawlStats): pages crawled, crawl errors, pages in index, inbound links, HTTP status counts.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        start_date: dateSchema.describe('Optional YYYY-MM-DD lower bound (local filter).'),
        end_date: dateSchema.describe('Optional YYYY-MM-DD upper bound (local filter).'),
      }),
    },
    async ({ site_url, start_date, end_date }) => {
      const bad = rangeError(start_date, end_date);
      if (bad) return errorResult(bad);
      try {
        const raw = list<RawCrawlStats>(await client.get<unknown>('GetCrawlStats', { siteUrl: site_url }));
        const all = raw.map((r) => ({
            date: bingDay(r.Date),
            crawled_pages: num(r.CrawledPages),
            crawl_errors: num(r.CrawlErrors),
            in_index: num(r.InIndex),
            in_links: num(r.InLinks),
            blocked_by_robots_txt: num(r.BlockedByRobotsTxt),
            contains_malware: num(r.ContainsMalware),
            code_2xx: num(r.Code2xx),
            code_301: num(r.Code301),
            code_302: num(r.Code302),
            code_4xx: num(r.Code4xx),
            code_5xx: num(r.Code5xx),
            all_other_codes: num(r.AllOtherCodes),
          }));
        const rows = all
          .filter((r) => inRange(r.date, start_date, end_date))
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return jsonResult({
          site_url,
          source: 'GetCrawlStats',
          data_range: dateSpan(rows.map((r) => r.date)),
          source_window: dateSpan(all.map((r) => r.date)),
          days: rows.length,
          rows,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_crawl_issues',
    {
      title: 'Bing: crawl issues',
      description:
        'URLs on a site where Bingbot hit crawl issues (GetCrawlIssues), with the HTTP code, decoded issue flags ' +
        '(Code301, Code302, Code4xx, Code5xx, BlockedByRobotsTxt, ContainsMalware, ImportantUrlBlockedByRobotsTxt, DnsErrors, TimeOutErrors) and inbound links. ' +
        'Fixed issues can take a few days to disappear.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        issue: z.string().nullish().describe('Optional: only URLs with this issue flag, e.g. "Code4xx".'),
        row_limit: rowLimitSchema,
      }),
    },
    async ({ site_url, issue, row_limit }) => {
      try {
        const raw = list<RawCrawlIssue>(await client.get<unknown>('GetCrawlIssues', { siteUrl: site_url }));
        let rows = raw.map((r) => ({
          url: r.Url ?? null,
          http_code: r.HttpCode ?? null,
          issues: decodeCrawlIssues(r.Issues),
          in_links: num(r.InLinks),
        }));
        if (issue) rows = rows.filter((r) => r.issues.some((i) => i.toLowerCase() === issue.toLowerCase()));
        rows.sort((a, b) => b.in_links - a.in_links);
        const counts: Record<string, number> = {};
        for (const r of rows) for (const i of r.issues) counts[i] = (counts[i] ?? 0) + 1;
        const limit = row_limit ?? 100;
        return jsonResult({
          site_url,
          source: 'GetCrawlIssues',
          total_urls: rows.length,
          issue_counts: counts,
          returned_rows: Math.min(limit, rows.length),
          rows: rows.slice(0, limit),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_url_info',
    {
      title: 'Bing: URL info',
      description:
        'Basic Bing index details for one URL (GetUrlInfo): HTTP status, size, anchor count, child URLs, discovery and last-crawl dates. ' +
        'This is NOT an equivalent of Google URL Inspection: Bing has no public URL inspection API.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        url: z.string().min(1).describe('The URL to look up (must belong to site_url).'),
      }),
    },
    async ({ site_url, url }) => {
      try {
        const r = (await client.get<RawUrlInfo | null>('GetUrlInfo', { siteUrl: site_url, url })) ?? {};
        return jsonResult({
          site_url,
          url: r.Url ?? url,
          http_status: r.HttpStatus ?? null,
          document_size: r.DocumentSize ?? null,
          anchor_count: r.AnchorCount ?? null,
          total_child_url_count: r.TotalChildUrlCount ?? null,
          is_page: r.IsPage ?? null,
          discovery_date: bingIso(r.DiscoveryDate),
          last_crawled_date: bingIso(r.LastCrawledDate),
          note: 'Bing exposes no URL inspection API; this is the basic index metadata from GetUrlInfo.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_link_counts',
    {
      title: 'Bing: inbound link counts',
      description: 'Pages of the site that have inbound links, with link counts (GetLinkCounts). Results are paged; start at page 0.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        page: z.number().int().min(0).max(32767).nullish().describe('0-based result page (default 0).'),
      }),
    },
    async ({ site_url, page }) => {
      try {
        const p = page ?? 0;
        const r = (await client.get<RawLinkCounts | null>('GetLinkCounts', { siteUrl: site_url, page: p })) ?? {};
        const totalPages = num(r.TotalPages);
        return jsonResult({
          site_url,
          page: p,
          total_pages: totalPages,
          has_more: p + 1 < totalPages,
          links: list<{ Url?: string; Count?: number }>(r.Links).map((l) => ({ url: l.Url ?? null, count: num(l.Count) })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_feeds',
    {
      title: 'Bing: sitemaps and feeds',
      description: 'Top-level sitemaps and feeds submitted for a site in Bing Webmaster Tools (GetFeeds), with status, URL count and dates.',
      inputSchema: z.object({ site_url: siteUrlSchema }),
    },
    async ({ site_url }) => {
      try {
        const feeds = list<RawFeed>(await client.get<unknown>('GetFeeds', { siteUrl: site_url }));
        return jsonResult({
          site_url,
          count: feeds.length,
          feeds: feeds.map((f) => ({
            url: f.Url ?? null,
            type: f.Type ?? null,
            status: f.Status ?? null,
            submitted: bingIso(f.Submitted),
            last_crawled: bingIso(f.LastCrawled),
            url_count: f.UrlCount ?? null,
            file_size: f.FileSize ?? null,
            compressed: f.Compressed ?? null,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_get_url_submission_quota',
    {
      title: 'Bing: URL submission quota',
      description: 'Remaining daily and monthly URL submission quota for a site (GetUrlSubmissionQuota). Check it before bing_submit_urls.',
      inputSchema: z.object({ site_url: siteUrlSchema }),
    },
    async ({ site_url }) => {
      try {
        const q = (await client.get<RawQuota | null>('GetUrlSubmissionQuota', { siteUrl: site_url })) ?? {};
        return jsonResult({ site_url, daily_quota: q.DailyQuota ?? null, monthly_quota: q.MonthlyQuota ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_submit_urls',
    {
      title: 'Bing: submit URLs',
      description:
        `Submit up to ${BING_SUBMIT_BATCH_MAX} URLs of a verified site to Bing for crawling (SubmitUrl for one, SubmitUrlBatch for several). ` +
        'Uses the site\'s daily URL submission quota (see bing_get_url_submission_quota). Microsoft recommends IndexNow for routine submissions. ' +
        'Requires GSC_SCOPES=full.',
      inputSchema: z.object({
        site_url: siteUrlSchema,
        urls: z.array(z.string().min(1)).min(1).max(BING_SUBMIT_BATCH_MAX).describe(`Absolute http(s) URLs (1-${BING_SUBMIT_BATCH_MAX}).`),
      }),
    },
    async ({ site_url, urls }) => {
      const gate = engineTierGate(tier(), 'bing_submit_urls', 'write', BING_LABEL);
      if (gate) return errorResult(gate);
      const cleaned = [...new Set(urls.map((u) => u.trim()))].filter((u) => u.length > 0);
      if (cleaned.length === 0) return errorResult('Error: urls must include at least one non-empty URL.');
      const invalid = cleaned.filter((u) => !parseHttpUrl(u));
      if (invalid.length > 0) return errorResult(`Error: not absolute http(s) URLs (or they carry credentials): ${invalid.slice(0, 10).join(', ')}`);
      try {
        if (cleaned.length === 1) {
          await client.post('SubmitUrl', { siteUrl: site_url, url: cleaned[0] });
        } else {
          await client.post('SubmitUrlBatch', { siteUrl: site_url, urlList: cleaned });
        }
        return jsonResult({
          site_url,
          submitted: cleaned.length,
          method: cleaned.length === 1 ? 'SubmitUrl' : 'SubmitUrlBatch',
          note: 'Bing accepted the submission; crawling and indexing are not guaranteed.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const feedShape = {
    site_url: siteUrlSchema,
    feed_url: z.string().min(1).describe('Absolute URL of the sitemap or feed (Sitemap, RSS 2.0, Atom 0.3/1.0, or text file).'),
  };

  server.registerTool(
    'bing_submit_feed',
    {
      title: 'Bing: submit sitemap/feed',
      description: 'Submit a sitemap or feed for a site to Bing Webmaster Tools (SubmitFeed). Requires GSC_SCOPES=full.',
      inputSchema: z.object(feedShape),
    },
    async ({ site_url, feed_url }) => {
      const gate = engineTierGate(tier(), 'bing_submit_feed', 'write', BING_LABEL);
      if (gate) return errorResult(gate);
      if (!parseHttpUrl(feed_url)) return errorResult(`Error: feed_url must be an absolute http(s) URL without credentials: ${feed_url}`);
      try {
        await client.post('SubmitFeed', { siteUrl: site_url, feedUrl: feed_url.trim() });
        return jsonResult({ site_url, feed_url: feed_url.trim(), submitted: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'bing_remove_feed',
    {
      title: 'Bing: remove sitemap/feed',
      description: 'Remove a submitted sitemap or feed from Bing Webmaster Tools (RemoveFeed). Requires GSC_SCOPES=full and GSC_ALLOW_DESTRUCTIVE=true.',
      inputSchema: z.object(feedShape),
    },
    async ({ site_url, feed_url }) => {
      const gate = engineTierGate(tier(), 'bing_remove_feed', 'destructive', BING_LABEL);
      if (gate) return errorResult(gate);
      if (!parseHttpUrl(feed_url)) return errorResult(`Error: feed_url must be an absolute http(s) URL without credentials: ${feed_url}`);
      try {
        await client.post('RemoveFeed', { siteUrl: site_url, feedUrl: feed_url.trim() });
        return jsonResult({ site_url, feed_url: feed_url.trim(), removed: true });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
