import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../mcp/context.js';
import {
  DIMENSIONS,
  FILTER_DIMENSIONS,
  FILTER_OPERATORS,
  SEARCH_TYPES,
  dataStateToWire,
  type DataStateParam,
  type Dimension,
} from '../lib/enums.js';
import { isValidISODate, lastNDays } from '../lib/dates.js';
import { errorText, errorResult, jsonError, jsonResult, textResult } from './helpers.js';

/**
 * Advanced analytics tools, ported from the Python版 gsc_server.py
 * (get_performance_overview / get_advanced_search_analytics /
 * compare_search_periods / get_search_by_page_query) with the agreed
 * enhancements (plan §9): `type` wire field, hour/hourly_all support,
 * firstIncompleteDate/Hour metadata passthrough, multi-filter groups,
 * and automatic pagination.
 */

const API_PAGE_MAX = 25000; // hard cap per Search Analytics query request
const FILTER_EXPRESSION_MAX = 4096;
const HOUR_MAX_DAYS = 10; // hour dimension requires a date range of at most 10 days
const PAGINATION_NOTE = 'The API returns top rows only; totals are not guaranteed.';
const INCOMPLETE_NOTE = 'first_incomplete_date and first_incomplete_hour are in Pacific Time.';
const SORT_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
type SortMetric = (typeof SORT_METRICS)[number];

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SearchAnalyticsMetadata {
  firstIncompleteDate?: string;
  firstIncompleteHour?: number;
}

interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  metadata?: SearchAnalyticsMetadata;
}

interface ActiveFilter {
  dimension: string;
  operator: string;
  expression: string;
}

/** Shared row mapping: keys → dimension fields + rounded metrics (matches analytics.ts). */
function mapRows(rows: SearchAnalyticsRow[], dimensionList: readonly string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const entry: Record<string, unknown> = {};
    dimensionList.forEach((dim, i) => {
      entry[dim] = row.keys?.[i] ?? null;
    });
    entry.clicks = row.clicks ?? 0;
    entry.impressions = row.impressions ?? 0;
    entry.ctr = Number((row.ctr ?? 0).toFixed(4));
    entry.position = Number((row.position ?? 0).toFixed(1));
    return entry;
  });
}

/** Inclusive day count between two YYYY-MM-DD dates (UTC math, DST-safe). */
function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/** Passthrough of firstIncompleteDate/Hour metadata, only when present. */
function buildMetadata(metadata: SearchAnalyticsMetadata | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  if (metadata.firstIncompleteDate !== undefined) out.first_incomplete_date = metadata.firstIncompleteDate;
  if (metadata.firstIncompleteHour !== undefined) out.first_incomplete_hour = metadata.firstIncompleteHour;
  if (Object.keys(out).length === 0) return null;
  out.note = INCOMPLETE_NOTE;
  return out;
}

/** Parse + validate a filters JSON array; `filters` takes priority over the single-filter triple. */
function validateFilterList(list: unknown): { ok: true; filters: ActiveFilter[] } | { ok: false; error: string } {
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: 'Invalid filters value. Expected a non-empty JSON array of filter objects.' };
  }
  const out: ActiveFilter[] = [];
  for (const f of list) {
    if (typeof f !== 'object' || f === null || !('dimension' in f) || !('operator' in f) || !('expression' in f)) {
      return {
        ok: false,
        error: `Each filter object must have 'dimension', 'operator', and 'expression' keys. Invalid filter: ${JSON.stringify(f)}`,
      };
    }
    const { dimension, operator, expression } = f as Record<string, unknown>;
    if (typeof dimension !== 'string' || !(FILTER_DIMENSIONS as readonly string[]).includes(dimension)) {
      return { ok: false, error: `Invalid filter dimension '${String(dimension)}'. Allowed: ${FILTER_DIMENSIONS.join(', ')}` };
    }
    if (typeof operator !== 'string' || !(FILTER_OPERATORS as readonly string[]).includes(operator)) {
      return { ok: false, error: `Invalid filter operator '${String(operator)}'. Allowed: ${FILTER_OPERATORS.join(', ')}` };
    }
    if (typeof expression !== 'string') {
      return { ok: false, error: 'Filter expression must be a string.' };
    }
    if (expression.length > FILTER_EXPRESSION_MAX) {
      return { ok: false, error: `Filter expression exceeds the maximum length of ${FILTER_EXPRESSION_MAX} characters.` };
    }
    out.push({ dimension, operator, expression });
  }
  return { ok: true, filters: out };
}

/** Client-side sort within the returned page (the API only sorts by clicks descending). */
function sortRows(rows: Record<string, unknown>[], sortBy: SortMetric, sortDirection: string): void {
  const reverse = sortDirection.toLowerCase() !== 'ascending';
  rows.sort((a, b) => {
    const av = typeof a[sortBy] === 'number' ? (a[sortBy] as number) : 0;
    const bv = typeof b[sortBy] === 'number' ? (b[sortBy] as number) : 0;
    return reverse ? bv - av : av - bv;
  });
}

/**
 * The API has no orderBy and always ranks by clicks descending (#54). A
 * different sort only reorders the rows already returned, so say so.
 */
function sortLimitationNote(sortBy: SortMetric, sortDirection: string): string | null {
  if (sortBy === 'clicks' && sortDirection.toLowerCase() !== 'ascending') return null;
  return (
    'Sorted client-side within the rows Google returned. The Search Analytics API has no orderBy ' +
    'field and always ranks by clicks descending, so this is not a global sort — rows outside this window are omitted.'
  );
}

async function querySearchAnalytics(
  svc: ServerServices,
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<SearchAnalyticsResponse> {
  return svc.gsc.request<SearchAnalyticsResponse>(
    `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { method: 'POST', body },
  );
}

export function registerAdvancedAnalyticsTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'get_performance_overview',
    {
      title: 'Performance overview',
      description:
        'Get a performance overview for a specific property: total clicks/impressions/CTR/position ' +
        'plus a daily trend. Dates are computed in Pacific Time.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com").',
        ),
        days: z.number().int().min(1).max(5000).default(28)
          .describe('Number of days to look back (default 28, covering exactly 28 days inclusive).'),
      }),
    },
    async ({ site_url, days }) => {
      try {
        const { start, end } = lastNDays(days);
        const dataState = dataStateToWire(svc.config.dataState);

        const totalResp = await querySearchAnalytics(svc, site_url, {
          startDate: start,
          endDate: end,
          dimensions: [],
          rowLimit: 1,
          dataState,
        });

        const trendResp = await querySearchAnalytics(svc, site_url, {
          startDate: start,
          endDate: end,
          dimensions: ['date'],
          rowLimit: days,
          dataState,
        });

        const totalsRow = totalResp.rows?.[0];
        if (!totalsRow) {
          return textResult(`No performance data available for ${site_url} in the last ${days} days.`);
        }

        const trendRows = [...(trendResp.rows ?? [])].sort((a, b) => (a.keys?.[0] ?? '').localeCompare(b.keys?.[0] ?? ''));

        const result: Record<string, unknown> = {
          site_url,
          date_range: { start, end, days },
          totals: {
            clicks: totalsRow.clicks ?? 0,
            impressions: totalsRow.impressions ?? 0,
            ctr: Number((totalsRow.ctr ?? 0).toFixed(4)),
            position: Number((totalsRow.position ?? 0).toFixed(1)),
          },
          daily_trend: trendRows.map((row) => ({
            date: row.keys?.[0] ?? null,
            clicks: row.clicks ?? 0,
            impressions: row.impressions ?? 0,
            ctr: Number((row.ctr ?? 0).toFixed(4)),
            position: Number((row.position ?? 0).toFixed(1)),
          })),
        };
        const metadata = buildMetadata(trendResp.metadata);
        if (metadata) result.metadata = metadata;
        return jsonResult(result);
      } catch (e) {
        return errorResult(errorText('retrieving performance overview', e, site_url));
      }
    },
  );

  server.registerTool(
    'get_advanced_search_analytics',
    {
      title: 'Advanced search analytics',
      description:
        'Get advanced search analytics data with sorting, filtering, hourly dataState, and automatic ' +
        'pagination (up to 25000 rows across pages). When grouping by the "hour" dimension, pass ' +
        'data_state="hourly_all" and keep the date range within 10 days.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com").',
        ),
        // `.nullish()` so an explicit JSON null is "not given" (upstream #58).
        // `.optional()` advertises a string and rejects null before the tool runs.
        start_date: z.string().nullish()
          .describe('Start date in YYYY-MM-DD format (defaults to 28 days ago, Pacific Time).'),
        end_date: z.string().nullish()
          .describe('End date in YYYY-MM-DD format (defaults to today, Pacific Time).'),
        dimensions: z.string().default('query')
          .describe('Dimensions to group by, comma-separated (e.g., "query,page,device").'),
        search_type: z.string().default('web').describe(
          'Type of search results: web, image, video, news, discover, or googleNews (case-insensitive, default web).',
        ),
        row_limit: z.number().int().min(1).max(API_PAGE_MAX).default(1000).describe(
          `Rows per API page (default 1000, max ${API_PAGE_MAX} per request).`,
        ),
        max_rows: z.number().int().min(1).max(100000).nullish().describe(
          'Total row budget across all automatically-fetched pages (default: same as row_limit, i.e. ' +
          'single-page behavior). Set higher than row_limit to page through more data; each API page ' +
          `still carries at most ${API_PAGE_MAX} rows.`,
        ),
        start_row: z.number().int().min(0).default(0).describe('Starting row for pagination (default 0).'),
        sort_by: z.enum(SORT_METRICS).default('clicks').describe(
          'Metric to sort by (clicks, impressions, ctr, position). Applied client-side to the returned rows, ' +
          'since Google only sorts by clicks.',
        ),
        sort_direction: z.enum(['ascending', 'descending']).default('descending').describe(
          'Sort direction. For position, ascending puts the best (lowest) average position first.',
        ),
        filter_dimension: z.string().nullish()
          .describe('Single filter dimension. Use "filters" instead for multiple filters.'),
        filter_operator: z.string().default('contains').describe('Single filter operator.'),
        filter_expression: z.string().nullish().describe('Single filter expression value.'),
        filters: z.string().nullish().describe(
          'JSON array of filter objects with dimension/operator/expression keys, ANDed together. ' +
          'Overrides filter_dimension/filter_operator/filter_expression when provided.',
        ),
        data_state: z.string().nullish().describe(
          'Data freshness: "all" (default, matches GSC dashboard), "final" (confirmed data only, 2-3 day lag), ' +
          'or "hourly_all" (required when grouping by the hour dimension).',
        ),
      }),
    },
    async ({
      site_url,
      start_date,
      end_date,
      dimensions,
      search_type,
      row_limit,
      max_rows,
      start_row,
      sort_by,
      sort_direction,
      filter_dimension,
      filter_operator,
      filter_expression,
      filters,
      data_state,
    }) => {
      try {
        // Date range: explicit params, else the last 28 days in PT (exactly 28 days).
        const fallback = lastNDays(28);
        const start = start_date ?? fallback.start;
        const end = end_date ?? fallback.end;
        if (!isValidISODate(start) || !isValidISODate(end)) {
          return jsonError({ error: `Invalid date range: start_date="${start}", end_date="${end}". Expected YYYY-MM-DD.` });
        }
        if (start > end) {
          return jsonError({ error: `Invalid date range: start_date (${start}) is after end_date (${end}).` });
        }

        // Dimensions
        const dimensionList = dimensions.split(',').map((d) => d.trim()).filter(Boolean) as Dimension[];
        const invalidDims = dimensionList.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
        if (invalidDims.length > 0) {
          return jsonError({ error: `Invalid dimensions: ${invalidDims.join(', ')}. Allowed: ${DIMENSIONS.join(', ')}` });
        }
        if (dimensionList.length === 0) {
          return jsonError({ error: 'At least one dimension is required.' });
        }

        // search_type (compat param name) → wire field `type`. Match
        // case-insensitively but map back to the canonical wire value
        // (`googleNews` is camelCase — sending `googlenews` would be
        // rejected by the API; review P2-4).
        const loweredType = search_type.toLowerCase().trim();
        const resolvedType = SEARCH_TYPES.find((t) => t.toLowerCase() === loweredType);
        if (resolvedType === undefined) {
          return jsonError({ error: `Invalid search_type '${search_type}'. Allowed: ${SEARCH_TYPES.join(', ')}` });
        }

        // data_state: per-call override (all/final/hourly_all) or fall back to the global setting.
        const resolvedDataState = (data_state ?? svc.config.dataState).toLowerCase().trim();
        if (!['all', 'final', 'hourly_all'].includes(resolvedDataState)) {
          return jsonError({
            error: `Invalid data_state value '${data_state}'. Accepted values are 'all' (matches GSC dashboard), ` +
              "'final' (confirmed data only, 2-3 day lag), or 'hourly_all' (required for the hour dimension).",
          });
        }

        // hour dimension ⇔ hourly_all dataState, both directions, plus the
        // ≤10-day window (review P2-5).
        if (dimensionList.includes('hour')) {
          if (resolvedDataState !== 'hourly_all') {
            return jsonError({
              error: 'When grouping by the "hour" dimension, data_state must be "hourly_all" ' +
                `(hourly data is only available before Google aggregates it). Got "${resolvedDataState}".`,
            });
          }
          if (inclusiveDays(start, end) > HOUR_MAX_DAYS) {
            return jsonError({
              error: `The "hour" dimension supports a date range of at most ${HOUR_MAX_DAYS} days. ` +
                `${start} to ${end} spans ${inclusiveDays(start, end)} days.`,
            });
          }
        } else if (resolvedDataState === 'hourly_all') {
          return jsonError({
            error: 'data_state "hourly_all" is only valid when grouping by the "hour" dimension.',
          });
        }

        // Filters: multi-filter JSON array takes priority over the single-filter triple.
        let activeFilters: ActiveFilter[] = [];
        let filterGroups: { groupType: string; filters: ActiveFilter[] }[] | undefined;
        // null is omitted (upstream #58); only a non-empty string is a filter.
        if (filters != null && filters.trim() !== '') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(filters);
          } catch {
            return jsonError({ error: 'Invalid filters JSON. Please provide a valid JSON array of filter objects.' });
          }
          const validated = validateFilterList(parsed);
          if (!validated.ok) return jsonError({ error: validated.error });
          activeFilters = validated.filters;
          filterGroups = [{ groupType: 'AND', filters: activeFilters }];
        } else if (filter_dimension != null && filter_expression != null) {
          const validated = validateFilterList([{
            dimension: filter_dimension,
            operator: filter_operator,
            expression: filter_expression,
          }]);
          if (!validated.ok) return jsonError({ error: validated.error });
          activeFilters = validated.filters;
          filterGroups = [{ groupType: 'AND', filters: activeFilters }];
        }

        const baseBody: Record<string, unknown> = {
          startDate: start,
          endDate: end,
          dimensions: dimensionList,
          type: resolvedType,
          dataState: dataStateToWire(resolvedDataState as DataStateParam),
        };
        if (filterGroups) baseBody.dimensionFilterGroups = filterGroups;

        // Automatic pagination (plan §7-5): row_limit caps each API page,
        // max_rows caps the total collected. The cursor advances by actual
        // rows returned; the loop stops when the budget is spent or a page
        // comes back short/empty (review P2-7).
        const budget = Math.min(max_rows ?? row_limit, 100000);
        const collected: SearchAnalyticsRow[] = [];
        let pagesFetched = 0;
        let lastPageFull = false;
        let cursor = start_row;
        let remaining = budget;
        let lastMetadata: SearchAnalyticsMetadata | undefined;

        while (remaining > 0) {
          const pageSize = Math.min(row_limit, remaining, API_PAGE_MAX);
          const resp = await querySearchAnalytics(svc, site_url, { ...baseBody, startRow: cursor, rowLimit: pageSize });
          pagesFetched += 1;
          lastMetadata = resp.metadata;
          const rows = resp.rows ?? [];
          collected.push(...rows);
          remaining -= rows.length;
          if (rows.length < pageSize) {
            lastPageFull = false;
            break;
          }
          lastPageFull = true;
          if (remaining <= 0) break;
          cursor += rows.length;
        }

        const hasMore = lastPageFull;

        if (collected.length === 0) {
          const noData: Record<string, unknown> = {
            site_url,
            date_range: { start, end },
            search_type: resolvedType,
            dimensions: dimensionList,
            filters_applied: activeFilters,
            row_count: 0,
            rows: [],
            note: `No search analytics data found for ${site_url} with the specified parameters.`,
          };
          const sortNote = sortLimitationNote(sort_by, sort_direction);
          if (sortNote) noData.sort_note = sortNote;
          const metadata = buildMetadata(lastMetadata);
          if (metadata) noData.metadata = metadata;
          return jsonResult(noData);
        }

        const mapped = mapRows(collected, dimensionList);
        sortRows(mapped, sort_by, sort_direction);

        const result: Record<string, unknown> = {
          site_url,
          date_range: { start, end },
          search_type: resolvedType,
          dimensions: dimensionList,
          filters_applied: activeFilters,
          pagination: {
            start_row: start_row,
            row_count: mapped.length,
            has_more: hasMore,
            next_start_row: hasMore ? start_row + mapped.length : null,
            pages_fetched: pagesFetched,
            ...(max_rows != null ? { max_rows } : {}),
          },
          rows: mapped,
          note: PAGINATION_NOTE,
        };
        const sortNote = sortLimitationNote(sort_by, sort_direction);
        if (sortNote) result.sort_note = sortNote;
        const metadata = buildMetadata(lastMetadata);
        if (metadata) result.metadata = metadata;
        return jsonResult(result);
      } catch (e) {
        return errorResult(errorText('retrieving advanced search analytics', e, site_url));
      }
    },
  );

  server.registerTool(
    'compare_search_periods',
    {
      title: 'Compare search periods',
      description:
        'Compare search analytics data between two time periods. Period 1 is the analyzed period and ' +
        'Period 2 is the baseline; deltas are Period 1 relative to Period 2, percentages use Period 2 as ' +
        'the baseline (null when the baseline is zero). For a current-vs-previous comparison, pass the ' +
        'current period as Period 1 and the previous period as Period 2.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com").',
        ),
        period1_start: z.string().describe('Start date for period 1 / the analyzed period (YYYY-MM-DD).'),
        period1_end: z.string().describe('End date for period 1 / the analyzed period (YYYY-MM-DD).'),
        period2_start: z.string().describe('Start date for period 2 / the baseline period (YYYY-MM-DD).'),
        period2_end: z.string().describe('End date for period 2 / the baseline period (YYYY-MM-DD).'),
        dimensions: z.string().default('query').describe('Dimensions to group by, comma-separated (default: query).'),
        limit: z.number().int().min(1).max(1000).default(10).describe('Number of top results to compare (default 10).'),
      }),
    },
    async ({ site_url, period1_start, period1_end, period2_start, period2_end, dimensions, limit }) => {
      try {
        for (const [label, d] of [
          ['period1_start', period1_start],
          ['period1_end', period1_end],
          ['period2_start', period2_start],
          ['period2_end', period2_end],
        ] as const) {
          if (!isValidISODate(d)) {
            return jsonError({ error: `Invalid ${label} "${d}". Expected YYYY-MM-DD.` });
          }
        }
        if (period1_start > period1_end || period2_start > period2_end) {
          return jsonError({ error: 'Invalid period range: start date is after end date.' });
        }

        const dimensionList = dimensions.split(',').map((d) => d.trim()).filter(Boolean) as Dimension[];
        const invalidDims = dimensionList.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
        if (invalidDims.length > 0) {
          return jsonError({ error: `Invalid dimensions: ${invalidDims.join(', ')}. Allowed: ${DIMENSIONS.join(', ')}` });
        }
        if (dimensionList.length === 0) {
          return jsonError({ error: 'At least one dimension is required.' });
        }
        // This tool only queries with the global all/final dataState; the hour
        // dimension would be an invalid request (review P2-5).
        if (dimensionList.includes('hour')) {
          return jsonError({
            error: 'The "hour" dimension is only supported by get_advanced_search_analytics with ' +
              'data_state="hourly_all" and a date range of at most 10 days.',
          });
        }

        const dataState = dataStateToWire(svc.config.dataState);
        const [period1Resp, period2Resp] = await Promise.all([
          querySearchAnalytics(svc, site_url, {
            startDate: period1_start,
            endDate: period1_end,
            dimensions: dimensionList,
            rowLimit: 1000, // fetch generously so items can be matched across periods
            dataState,
          }),
          querySearchAnalytics(svc, site_url, {
            startDate: period2_start,
            endDate: period2_end,
            dimensions: dimensionList,
            rowLimit: 1000,
            dataState,
          }),
        ]);

        const period1Rows = period1Resp.rows ?? [];
        const period2Rows = period2Resp.rows ?? [];
        if (period1Rows.length === 0 && period2Rows.length === 0) {
          return textResult(`No data found for either period for ${site_url}.`);
        }

        // keys are matched across periods as tuples (JSON-serialised to avoid collisions).
        const keyOf = (row: SearchAnalyticsRow): string => JSON.stringify(row.keys ?? []);
        const period1Data = new Map(period1Rows.map((r) => [keyOf(r), r]));
        const period2Data = new Map(period2Rows.map((r) => [keyOf(r), r]));

        interface ComparisonEntry {
          keys: string[];
          p1: SearchAnalyticsRow;
          p2: SearchAnalyticsRow;
          clickDiff: number;
          impDiff: number;
        }
        const allKeys = new Set<string>([...period1Data.keys(), ...period2Data.keys()]);
        const emptyRow: SearchAnalyticsRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
        const comparison: ComparisonEntry[] = [];
        for (const key of allKeys) {
          const p1 = period1Data.get(key) ?? emptyRow;
          const p2 = period2Data.get(key) ?? emptyRow;
          comparison.push({
            keys: (p1.keys ?? p2.keys ?? []).slice(),
            p1,
            p2,
            clickDiff: (p1.clicks ?? 0) - (p2.clicks ?? 0),
            impDiff: (p1.impressions ?? 0) - (p2.impressions ?? 0),
          });
        }
        comparison.sort((a, b) => Math.abs(b.clickDiff) - Math.abs(a.clickDiff));

        const serialisable = comparison.slice(0, limit).map((item) => {
          const p1 = item.p1;
          const p2 = item.p2;
          const p1Clicks = p1.clicks ?? 0;
          const p2Clicks = p2.clicks ?? 0;
          const p1Impressions = p1.impressions ?? 0;
          const p2Impressions = p2.impressions ?? 0;
          const clickDiff = p1Clicks - p2Clicks;
          const impDiff = p1Impressions - p2Impressions;
          // Deltas are Period 1 relative to Period 2; percentages use Period 2 as
          // the baseline and are null when that baseline is zero. For position,
          // positive means Period 1 improved (lower position is better).
          return {
            key: item.keys,
            p1_clicks: p1Clicks,
            p2_clicks: p2Clicks,
            click_diff: clickDiff,
            click_pct: p2Clicks > 0 ? Number(((clickDiff / p2Clicks) * 100).toFixed(1)) : null,
            p1_impressions: p1Impressions,
            p2_impressions: p2Impressions,
            imp_diff: impDiff,
            imp_pct: p2Impressions > 0 ? Number(((impDiff / p2Impressions) * 100).toFixed(1)) : null,
            p1_ctr: Number((p1.ctr ?? 0).toFixed(4)),
            p2_ctr: Number((p2.ctr ?? 0).toFixed(4)),
            ctr_diff: Number(((p1.ctr ?? 0) - (p2.ctr ?? 0)).toFixed(4)),
            p1_position: Number((p1.position ?? 0).toFixed(1)),
            p2_position: Number((p2.position ?? 0).toFixed(1)),
            position_diff: Number(((p2.position ?? 0) - (p1.position ?? 0)).toFixed(1)),
          };
        });

        const result: Record<string, unknown> = {
          site_url,
          period1: { start: period1_start, end: period1_end },
          period2: { start: period2_start, end: period2_end },
          dimensions: dimensionList,
          total_items: comparison.length,
          showing: serialisable.length,
          comparison: serialisable,
        };
        // Per-period incompleteness markers are kept separate (review P2-6).
        const meta1 = buildMetadata(period1Resp.metadata);
        const meta2 = buildMetadata(period2Resp.metadata);
        if (meta1) result.metadata_period1 = meta1;
        if (meta2) result.metadata_period2 = meta2;
        return jsonResult(result);
      } catch (e) {
        return errorResult(errorText('comparing search periods', e, site_url));
      }
    },
  );

  server.registerTool(
    'get_search_by_page_query',
    {
      title: 'Search queries for a page',
      description:
        'Get search analytics data for a specific page, broken down by query. ' +
        'Dates are computed in Pacific Time.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com").',
        ),
        page_url: z.string().describe('The specific page URL to analyze.'),
        days: z.number().int().min(1).max(5000).default(28)
          .describe('Number of days to look back (default 28, covering exactly 28 days inclusive).'),
        row_limit: z.number().int().min(1).max(500).default(20).describe(
          'Number of rows to return (default 20, max 500). For bulk exports beyond 500 rows, ' +
          'use get_advanced_search_analytics which supports pagination.',
        ),
      }),
    },
    async ({ site_url, page_url, days, row_limit }) => {
      try {
        const { start, end } = lastNDays(days);

        const resp = await querySearchAnalytics(svc, site_url, {
          startDate: start,
          endDate: end,
          dimensions: ['query'],
          dimensionFilterGroups: [{
            groupType: 'AND',
            filters: [{ dimension: 'page', operator: 'equals', expression: page_url }],
          }],
          rowLimit: Math.min(Math.max(1, row_limit), 500),
          // The API has no orderBy field — it always returns rows sorted by clicks descending.
          dataState: dataStateToWire(svc.config.dataState),
        });

        const rows = resp.rows ?? [];
        if (rows.length === 0) {
          return textResult(`No search data found for page ${page_url} in the last ${days} days.`);
        }

        const mapped = mapRows(rows, ['query']);
        const totalClicks = mapped.reduce((sum, r) => sum + (r.clicks as number), 0);
        const totalImpressions = mapped.reduce((sum, r) => sum + (r.impressions as number), 0);

        const result: Record<string, unknown> = {
          site_url,
          page_url,
          date_range: { start, end, days },
          totals: {
            clicks: totalClicks,
            impressions: totalImpressions,
            avg_ctr: totalImpressions > 0 ? Number((totalClicks / totalImpressions).toFixed(4)) : 0,
          },
          row_count: mapped.length,
          rows: mapped,
        };
        const metadata = buildMetadata(resp.metadata);
        if (metadata) result.metadata = metadata;
        return jsonResult(result);
      } catch (e) {
        return errorResult(errorText('retrieving page query data', e, site_url));
      }
    },
  );
}
