import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../mcp/context.js';
import { errorText, errorResult, formatDateTime, jsonResult, textResult } from './helpers.js';

/** API response shapes for POST /v1/urlInspection/index:inspect. */
interface IndexStatusResult {
  verdict?: string;
  coverageState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
  referringUrls?: string[];
}

interface RichResultIssue {
  severity?: string;
  issueMessage?: string;
}

interface RichResultItem {
  name?: string;
  issues?: RichResultIssue[];
}

interface RichResultsDetectedItem {
  richResultType?: string;
  items?: RichResultItem[];
}

interface RichResultsResult {
  verdict?: string;
  detectedItems?: RichResultsDetectedItem[];
}

interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  richResultsResult?: RichResultsResult;
  ampResult?: unknown;
}

interface InspectResponse {
  inspectionResult?: InspectionResult;
}

/** Mirrors the Python `_rich_results_summary` (detectedItems[].items[].issues[]). */
function richResultsSummary(inspection: InspectionResult): Record<string, unknown> | null {
  const rich = inspection.richResultsResult;
  if (rich === undefined) return null;

  const detectedItems = rich.detectedItems ?? [];
  return {
    verdict: rich.verdict ?? 'UNKNOWN',
    detected_types: detectedItems.map((item) => item.richResultType ?? 'Unknown'),
    issues: detectedItems.flatMap((detected) =>
      (detected.items ?? []).flatMap((item) =>
        (item.issues ?? []).map((issue) => ({
          type: detected.richResultType ?? 'Unknown',
          item: item.name ?? null,
          severity: issue.severity ?? null,
          message: issue.issueMessage ?? null,
        })),
      ),
    ),
  };
}

/** Date-only (YYYY-MM-DD, UTC) variant of formatDateTime for batch rows. */
function formatDateUTC(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function parseUrls(urls: string): string[] {
  return urls
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
}

const TOO_MANY_URLS = (n: number) =>
  `Too many URLs provided (${n}). Please limit to 10 URLs per batch to avoid API quota issues.`;

const QUOTA_NOTE = 'URL Inspection is limited to 2,000 queries per day per site.';

/** Simple Promise pool preserving input order (plan: concurrency 5). */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (next >= items.length) return;
      const i = next;
      next += 1;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function inspectRequest(
  gsc: ServerServices['gsc'],
  siteUrl: string,
  pageUrl: string,
  languageCode?: string,
): Promise<InspectResponse> {
  const body: Record<string, string> = { inspectionUrl: pageUrl, siteUrl };
  if (languageCode !== undefined) body.languageCode = languageCode;
  return gsc.request<InspectResponse>('/v1/urlInspection/index:inspect', {
    method: 'POST',
    body,
  });
}

/** One batch row; never throws — failures come back as an `error` row. */
async function inspectSingleUrl(
  svc: ServerServices,
  siteUrl: string,
  pageUrl: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await inspectRequest(svc.gsc, siteUrl, pageUrl);
    const inspection = response.inspectionResult;
    if (!inspection) return { url: pageUrl, error: 'No inspection data found' };

    const indexStatus = inspection.indexStatusResult ?? {};
    let lastCrawl = 'Never';
    if (indexStatus.lastCrawlTime !== undefined) {
      lastCrawl = formatDateUTC(indexStatus.lastCrawlTime);
    }

    return {
      url: pageUrl,
      index_verdict: indexStatus.verdict ?? 'UNKNOWN',
      coverage_state: indexStatus.coverageState ?? 'Unknown',
      last_crawled: lastCrawl,
      rich_results: richResultsSummary(inspection),
    };
  } catch (e) {
    return { url: pageUrl, error: e instanceof Error ? e.message : String(e) };
  }
}

interface IndexingClassification {
  not_indexed: string | null;
  canonical_issues: string | null;
  robots_blocked: string | null;
  fetch_issues: string | null;
  indexed: string | null;
}

/** One classification; never throws — failures land in `not_indexed`. */
async function checkIndexingSingleUrl(
  svc: ServerServices,
  siteUrl: string,
  pageUrl: string,
): Promise<IndexingClassification> {
  const result: IndexingClassification = {
    not_indexed: null,
    canonical_issues: null,
    robots_blocked: null,
    fetch_issues: null,
    indexed: null,
  };
  try {
    const response = await inspectRequest(svc.gsc, siteUrl, pageUrl);
    const inspection = response.inspectionResult;
    if (!inspection) {
      result.not_indexed = `${pageUrl} - No inspection data found`;
      return result;
    }

    const indexStatus = inspection.indexStatusResult ?? {};
    const verdict = indexStatus.verdict ?? 'UNKNOWN';
    const coverage = indexStatus.coverageState ?? 'Unknown';

    if (verdict !== 'PASS' || coverage.toLowerCase().includes('not indexed') || coverage.toLowerCase().includes('excluded')) {
      result.not_indexed = `${pageUrl} - ${coverage}`;
    } else {
      result.indexed = pageUrl;
    }

    const googleCanonical = indexStatus.googleCanonical ?? '';
    const userCanonical = indexStatus.userCanonical ?? '';
    if (googleCanonical && userCanonical && googleCanonical !== userCanonical) {
      result.canonical_issues = `${pageUrl} - Google chose: ${googleCanonical} instead of user-declared: ${userCanonical}`;
    }

    if (indexStatus.robotsTxtState === 'BLOCKED') {
      result.robots_blocked = pageUrl;
    }

    const fetchState = indexStatus.pageFetchState ?? '';
    if (fetchState !== 'SUCCESSFUL') {
      result.fetch_issues = `${pageUrl} - ${fetchState}`;
    }
  } catch (e) {
    result.not_indexed = `${pageUrl} - Error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return result;
}

export function registerInspectionTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'inspect_url_enhanced',
    {
      title: 'Inspect URL (enhanced)',
      description:
        'Enhanced URL inspection to check indexing status and rich results in Google. ' +
        'Supports language selection and optional AMP result output.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com"). ' +
            'Domain properties cover all subdomains — use the domain property as site_url and filter by page to analyze a specific subdomain.',
        ),
        page_url: z.string().describe('The specific URL to inspect.'),
        language_code: z.string().default('en-US')
          .describe('BCP-47 language code for localized results (default "en-US").'),
        include_amp: z.boolean().default(false)
          .describe('Include the AMP inspection result (ampResult) when available (default false).'),
      }),
    },
    async ({ site_url, page_url, language_code, include_amp }) => {
      try {
        const response = await inspectRequest(svc.gsc, site_url, page_url, language_code);
        const inspection = response.inspectionResult;
        if (!inspection) {
          return textResult(`No inspection data found for ${page_url}.`);
        }

        const indexStatus = inspection.indexStatusResult ?? {};
        const output: Record<string, unknown> = {
          page_url,
          site_url,
          inspection_result_link: inspection.inspectionResultLink ?? null,
          verdict: indexStatus.verdict ?? 'UNKNOWN',
          coverage_state: indexStatus.coverageState ?? null,
          last_crawled: formatDateTime(indexStatus.lastCrawlTime),
          page_fetch_state: indexStatus.pageFetchState ?? null,
          robots_txt_state: indexStatus.robotsTxtState ?? null,
          indexing_state: indexStatus.indexingState ?? null,
          google_canonical: indexStatus.googleCanonical ?? null,
          user_canonical: indexStatus.userCanonical ?? null,
          crawled_as: indexStatus.crawledAs ?? null,
          referring_urls: (indexStatus.referringUrls ?? []).slice(0, 5),
          rich_results: richResultsSummary(inspection),
        };
        // ampResult is opt-in (mobileUsabilityResult is deprecated and never returned).
        if (include_amp && inspection.ampResult !== undefined) {
          output.amp = inspection.ampResult;
        }

        return jsonResult(output);
      } catch (e) {
        return errorResult(errorText('inspecting URL', e, site_url));
      }
    },
  );

  server.registerTool(
    'batch_url_inspection',
    {
      title: 'Batch URL inspection',
      description:
        'Inspect multiple URLs in batch (within API limits). URLs are inspected concurrently. ' +
        'Max 10 URLs per batch.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com"). ' +
            'Domain properties cover all subdomains — use the domain property as site_url and filter by page to analyze a specific subdomain.',
        ),
        urls: z.string().describe('List of URLs to inspect, one per line (max 10).'),
      }),
    },
    async ({ site_url, urls }) => {
      const urlList = parseUrls(urls);
      if (urlList.length === 0) return errorResult('No URLs provided for inspection.');
      if (urlList.length > 10) return errorResult(TOO_MANY_URLS(urlList.length));

      try {
        const results = await runWithConcurrency(urlList, 5, (pageUrl) =>
          inspectSingleUrl(svc, site_url, pageUrl),
        );
        return jsonResult({
          site_url,
          count: results.length,
          results,
          quota_note: QUOTA_NOTE,
        });
      } catch (e) {
        return errorResult(errorText('performing batch inspection', e, site_url));
      }
    },
  );

  server.registerTool(
    'check_indexing_issues',
    {
      title: 'Check indexing issues',
      description:
        'Check for specific indexing issues (not indexed, canonical mismatches, robots.txt blocks, fetch failures) across multiple URLs. ' +
        'Max 10 URLs per batch.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com"). ' +
            'Domain properties cover all subdomains — use the domain property as site_url and filter by page to analyze a specific subdomain.',
        ),
        urls: z.string().describe('List of URLs to check, one per line (max 10).'),
      }),
    },
    async ({ site_url, urls }) => {
      const urlList = parseUrls(urls);
      if (urlList.length === 0) return errorResult('No URLs provided for inspection.');
      if (urlList.length > 10) return errorResult(TOO_MANY_URLS(urlList.length));

      try {
        const perUrl = await runWithConcurrency(urlList, 5, (pageUrl) =>
          checkIndexingSingleUrl(svc, site_url, pageUrl),
        );

        const issuesSummary: Record<keyof IndexingClassification, string[]> = {
          not_indexed: [],
          canonical_issues: [],
          robots_blocked: [],
          fetch_issues: [],
          indexed: [],
        };
        for (const entry of perUrl) {
          for (const category of Object.keys(issuesSummary) as (keyof IndexingClassification)[]) {
            const value = entry[category];
            if (value !== null) issuesSummary[category].push(value);
          }
        }

        return jsonResult({
          site_url,
          summary: {
            total_checked: urlList.length,
            indexed: issuesSummary.indexed.length,
            not_indexed: issuesSummary.not_indexed.length,
            canonical_issues: issuesSummary.canonical_issues.length,
            robots_blocked: issuesSummary.robots_blocked.length,
            fetch_issues: issuesSummary.fetch_issues.length,
          },
          issues: {
            not_indexed: issuesSummary.not_indexed,
            canonical_issues: issuesSummary.canonical_issues,
            robots_blocked: issuesSummary.robots_blocked,
            fetch_issues: issuesSummary.fetch_issues,
          },
          indexed_urls: issuesSummary.indexed,
          quota_note: QUOTA_NOTE,
        });
      } catch (e) {
        return errorResult(errorText('checking indexing issues', e, site_url));
      }
    },
  );
}
