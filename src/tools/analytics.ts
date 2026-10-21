import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../mcp/context.js';
import { DIMENSIONS, type Dimension } from '../lib/enums.js';
import { lastNDays } from '../lib/dates.js';
import { errorText, errorResult, jsonError, jsonResult } from './helpers.js';
import { toolAnnotations } from '../mcp/tool-annotations.js';
import { GSC_TOOLS } from './tool-tiers.js';

/** Python版 semantics, kept for M1; §9.2-4 决策后可能调整 (see plan). */
const ROW_LIMIT_MAX = 500;

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

/** Passthrough of firstIncompleteDate/Hour metadata (Pacific Time), when present. */
function metadataResult(resp: SearchAnalyticsResponse): Record<string, unknown> | null {
  const m = resp.metadata;
  if (!m) return null;
  const out: Record<string, unknown> = {};
  if (m.firstIncompleteDate !== undefined) out.first_incomplete_date = m.firstIncompleteDate;
  if (m.firstIncompleteHour !== undefined) out.first_incomplete_hour = m.firstIncompleteHour;
  if (Object.keys(out).length === 0) return null;
  out.note = 'first_incomplete_date and first_incomplete_hour are in Pacific Time.';
  return out;
}

export function registerAnalyticsTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'get_search_analytics',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'get_search_analytics'),
      title: 'Search analytics',
      description:
        'Get search analytics data (clicks, impressions, CTR, position) for a specific property. ' +
        'Dates are computed in Pacific Time. Do NOT use position/searchAppearance to infer AI Overview exposure — that data is UI-only (see get_capabilities).',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com").',
        ),
        days: z.number().int().min(1).max(5000).default(28)
          .describe('Number of days to look back (default 28, covering exactly 28 days inclusive).'),
        dimensions: z.string().default('query').describe(
          'Dimensions to group by, comma-separated: query, page, device, country, date, searchAppearance ' +
          '(hour is only supported by get_advanced_search_analytics with data_state="hourly_all").',
        ),
        row_limit: z.number().int().min(1).max(ROW_LIMIT_MAX).default(20).describe(
          `Number of rows to return (default 20, max ${ROW_LIMIT_MAX} in this tool).`,
        ),
      }),
    },
    async ({ site_url, days, dimensions, row_limit }) => {
      try {
        const dimensionList = dimensions
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean) as Dimension[];
        const invalid = dimensionList.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
        if (invalid.length > 0) {
          return jsonError({
            error: `Invalid dimensions: ${invalid.join(', ')}. Allowed: ${DIMENSIONS.join(', ')}`,
          });
        }
        if (dimensionList.length === 0) {
          return jsonError({ error: 'At least one dimension is required.' });
        }
        // The hour dimension requires dataState=hourly_all and a ≤10-day range;
        // this tool only sends all/final, so reject it here instead of letting
        // an invalid request reach the API (review P2-5).
        if (dimensionList.includes('hour')) {
          return jsonError({
            error: 'The "hour" dimension is only supported by get_advanced_search_analytics with ' +
              'data_state="hourly_all" and a date range of at most 10 days.',
          });
        }

        const { start, end } = lastNDays(days);

        const data = await svc.gsc.request<SearchAnalyticsResponse>(
          `/webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`,
          {
            method: 'POST',
            body: {
              startDate: start,
              endDate: end,
              dimensions: dimensionList,
              rowLimit: Math.min(Math.max(1, row_limit), ROW_LIMIT_MAX),
              dataState: svc.config.dataState === 'all' ? 'all' : 'final',
            },
          },
        );

        const rows = data.rows ?? [];
        const metadata = metadataResult(data);
        if (rows.length === 0) {
          return jsonResult({
            site_url,
            date_range: { start, end, days },
            dimensions: dimensionList,
            row_count: 0,
            rows: [],
            ...(metadata ? { metadata } : {}),
            note: `No search analytics data found for ${site_url} in the selected period.`,
          });
        }

        return jsonResult({
          site_url,
          date_range: { start, end, days },
          dimensions: dimensionList,
          ...(metadata ? { metadata } : {}),
          row_count: rows.length,
          rows: rows.map((row) => {
            const entry: Record<string, unknown> = {};
            dimensionList.forEach((dim, i) => {
              entry[dim] = row.keys?.[i] ?? null;
            });
            entry.clicks = row.clicks ?? 0;
            entry.impressions = row.impressions ?? 0;
            entry.ctr = Number((row.ctr ?? 0).toFixed(4));
            entry.position = Number((row.position ?? 0).toFixed(1));
            return entry;
          }),
        });
      } catch (e) {
        return errorResult(errorText('retrieving search analytics', e, site_url));
      }
    },
  );
}
