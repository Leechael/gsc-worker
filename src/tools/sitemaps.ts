import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../mcp/context.js';
import { GscApiError } from '../lib/gsc-client.js';
import { errorText, errorResult, textResult, tierGateMessage, formatDateTime } from './helpers.js';
import { toolAnnotations } from '../mcp/tool-annotations.js';
import { GSC_TOOLS } from './tool-tiers.js';

interface SitemapContent {
  type?: string;
  submitted?: number;
  indexed?: number | null;
}

interface SitemapEntry {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  errors?: number | string;
  warnings?: number | string;
  isSitemapsIndex?: boolean;
  isPending?: boolean;
  contents?: SitemapContent[];
}

interface SitemapListResponse {
  sitemap?: SitemapEntry[];
}

type SitemapDetails = SitemapEntry;

function sitemapsPath(siteUrl: string, feedpath?: string): string {
  const base = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
  return feedpath === undefined ? base : `${base}/${encodeURIComponent(feedpath)}`;
}

/** Port of Python get_sitemaps (gsc_server.py). */
async function getSitemaps(svc: ServerServices, siteUrl: string) {
  try {
    const data = await svc.gsc.request<SitemapListResponse>(sitemapsPath(siteUrl));

    if (!data.sitemap || data.sitemap.length === 0) {
      return textResult(`No sitemaps found for ${siteUrl}.`);
    }

    const sitemapList = data.sitemap.map((sitemap) => {
      const errors = Number(sitemap.errors ?? 0);
      const warnings = Number(sitemap.warnings ?? 0);

      let status = 'Valid';
      if (errors > 0) {
        status = 'Has errors';
      } else if (warnings > 0) {
        status = 'Has warnings';
      }

      // `submitted` is the URL count Google parsed from the sitemap — it is
      // NOT the number of indexed URLs. contents[].indexed is deprecated by
      // Google and mostly null, so it must not be presented as an index-count
      // metric (plan §1.5-10 / §7-8, review P2-9).
      let submittedUrls: number | null = null;
      if (sitemap.contents) {
        for (const content of sitemap.contents) {
          if (content.type === 'web') {
            submittedUrls = content.submitted ?? null;
            break;
          }
        }
      }

      return {
        path: sitemap.path ?? 'Unknown',
        last_downloaded: formatDateTime(sitemap.lastDownloaded),
        status,
        submitted_urls: submittedUrls,
        errors,
        warnings,
      };
    });

    return textResult(JSON.stringify({
      site_url: siteUrl,
      count: sitemapList.length,
      sitemaps: sitemapList,
    }));
  } catch (e) {
    return errorResult(errorText('retrieving sitemaps', e, siteUrl));
  }
}

/** Port of Python list_sitemaps_enhanced. */
async function listSitemapsEnhanced(
  svc: ServerServices,
  siteUrl: string,
  sitemapIndex?: string | null,
) {
  try {
    const data = await svc.gsc.request<SitemapListResponse>(sitemapsPath(siteUrl), {
      query: { sitemapIndex },
    });

    if (!data.sitemap || data.sitemap.length === 0) {
      return textResult(
        `No sitemaps found for ${siteUrl}` + (sitemapIndex ? ` in index ${sitemapIndex}` : '.'),
      );
    }

    const sitemapList = data.sitemap.map((sitemap) => {
      let urlCount: number | null = null;
      if (sitemap.contents) {
        for (const content of sitemap.contents) {
          if (content.type === 'web') {
            urlCount = content.submitted ?? null;
            break;
          }
        }
      }
      return {
        path: sitemap.path ?? 'Unknown',
        last_submitted: formatDateTime(sitemap.lastSubmitted),
        last_downloaded: formatDateTime(sitemap.lastDownloaded),
        type: sitemap.isSitemapsIndex ? 'Index' : 'Sitemap',
        is_pending: sitemap.isPending ?? false,
        url_count: urlCount,
        errors: Number(sitemap.errors ?? 0),
        warnings: Number(sitemap.warnings ?? 0),
      };
    });

    const pendingCount = sitemapList.filter((s) => s.is_pending).length;

    return textResult(JSON.stringify({
      site_url: siteUrl,
      sitemap_index: sitemapIndex ?? null,
      count: sitemapList.length,
      pending_count: pendingCount,
      sitemaps: sitemapList,
    }));
  } catch (e) {
    return errorResult(errorText('retrieving sitemaps', e, siteUrl));
  }
}

/** Port of Python get_sitemap_details. */
async function getSitemapDetails(
  svc: ServerServices,
  siteUrl: string,
  sitemapUrl: string,
) {
  try {
    const details = await svc.gsc.request<SitemapDetails>(sitemapsPath(siteUrl, sitemapUrl));

    // The client maps an empty success body to {}.
    if (!details || Object.keys(details).length === 0) {
      return textResult(`No details found for sitemap ${sitemapUrl}.`);
    }

    const isIndex = details.isSitemapsIndex ?? false;
    // `indexed` is deprecated by Google (rarely populated); it is kept under
    // an explicit name so it is never read as a live index-count metric.
    const contentBreakdown = (details.contents ?? []).map((content) => ({
      type: (content.type ?? 'unknown').toUpperCase(),
      submitted: content.submitted ?? 0,
      indexed_deprecated: content.indexed ?? null,
    }));

    return textResult(JSON.stringify({
      sitemap_url: sitemapUrl,
      site_url: siteUrl,
      type: isIndex ? 'Index' : 'Sitemap',
      status: details.isPending ? 'pending' : 'processed',
      last_submitted: formatDateTime(details.lastSubmitted),
      last_downloaded: formatDateTime(details.lastDownloaded),
      errors: Number(details.errors ?? 0),
      warnings: Number(details.warnings ?? 0),
      content_breakdown: contentBreakdown,
      is_index: isIndex,
    }));
  } catch (e) {
    return errorResult(errorText('retrieving sitemap details', e));
  }
}

/** Port of Python submit_sitemap (gated 'write' — needs full/webmasters scope). */
async function submitSitemap(
  svc: ServerServices,
  siteUrl: string,
  sitemapUrl: string,
) {
  const gate = tierGateMessage(svc.config.scopeTier, 'submit_sitemap', 'write');
  if (gate) return errorResult(gate);
  try {
    await svc.gsc.request(sitemapsPath(siteUrl, sitemapUrl), { method: 'PUT' });

    // Verify submission by getting details
    try {
      const details = await svc.gsc.request<SitemapDetails>(sitemapsPath(siteUrl, sitemapUrl));

      const resultLines = [`Successfully submitted sitemap: ${sitemapUrl}`];

      if (details.lastSubmitted) {
        resultLines.push(`Submission time: ${formatDateTime(details.lastSubmitted)}`);
      }

      const isPending = details.isPending ?? true;
      resultLines.push(`Status: ${isPending ? 'Pending processing' : 'Processing started'}`);

      resultLines.push(
        '\nNote: Google may take some time to process the sitemap. Check back later for full details.',
      );

      return textResult(resultLines.join('\n'));
    } catch {
      // If we can't get details, just return basic success message
      return textResult(`Successfully submitted sitemap: ${sitemapUrl}\n\nGoogle will queue it for processing.`);
    }
  } catch (e) {
    return errorResult(errorText('submitting sitemap', e));
  }
}

/** Port of Python delete_sitemap (gated 'destructive'; GET-existence check first). */
async function deleteSitemap(
  svc: ServerServices,
  siteUrl: string,
  sitemapUrl: string,
) {
  const gate = tierGateMessage(svc.config.scopeTier, 'delete_sitemap', 'destructive');
  if (gate) return errorResult(gate);
  try {
    // First check if the sitemap exists
    try {
      await svc.gsc.request<SitemapDetails>(sitemapsPath(siteUrl, sitemapUrl));
    } catch (e) {
      if (e instanceof GscApiError && e.status === 404) {
        return errorResult(`Sitemap not found: ${sitemapUrl}. It may have already been deleted or was never submitted.`);
      }
      throw e;
    }

    await svc.gsc.request(sitemapsPath(siteUrl, sitemapUrl), { method: 'DELETE' });

    return textResult(
      `Successfully deleted sitemap: ${sitemapUrl}\n\n` +
      'Note: This only removes the sitemap from Search Console. Any URLs already indexed will remain in Google\'s index.',
    );
  } catch (e) {
    return errorResult(errorText('deleting sitemap', e));
  }
}

const SITE_URL_DESCRIPTION =
  'Exact GSC property URL from list_properties (e.g. "https://example.com/" or ' +
  '"sc-domain:example.com"). Domain properties cover all subdomains — use the ' +
  'domain property as site_url and filter by page to analyze a specific subdomain.';

export function registerSitemapsTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'get_sitemaps',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'get_sitemaps'),
      title: 'Get sitemaps',
      description: 'List all sitemaps for a specific Search Console property.',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
      }),
    },
    async ({ site_url }) => getSitemaps(svc, site_url),
  );

  server.registerTool(
    'list_sitemaps_enhanced',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'list_sitemaps_enhanced'),
      title: 'List sitemaps (enhanced)',
      description:
        'List all sitemaps for a specific Search Console property with detailed information.',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
        sitemap_index: z.string().nullish().describe(
          'Optional sitemap index URL to list child sitemaps. Explicit null means omitted.',
        ),
      }),
    },
    async ({ site_url, sitemap_index }) =>
      listSitemapsEnhanced(svc, site_url, sitemap_index),
  );

  server.registerTool(
    'get_sitemap_details',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'get_sitemap_details'),
      title: 'Get sitemap details',
      description: 'Get detailed information about a specific sitemap.',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
        sitemap_url: z.string().describe('The full URL of the sitemap to inspect.'),
      }),
    },
    async ({ site_url, sitemap_url }) =>
      getSitemapDetails(svc, site_url, sitemap_url),
  );

  server.registerTool(
    'submit_sitemap',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'submit_sitemap'),
      title: 'Submit sitemap',
      description: 'Submit a new sitemap or resubmit an existing one to Google.',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
        sitemap_url: z.string().describe('The full URL of the sitemap to submit.'),
      }),
    },
    async ({ site_url, sitemap_url }) =>
      submitSitemap(svc, site_url, sitemap_url),
  );

  server.registerTool(
    'delete_sitemap',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'delete_sitemap'),
      title: 'Delete sitemap',
      description: 'Delete (unsubmit) a sitemap from Google Search Console.',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
        sitemap_url: z.string().describe('The full URL of the sitemap to delete.'),
      }),
    },
    async ({ site_url, sitemap_url }) =>
      deleteSitemap(svc, site_url, sitemap_url),
  );

  server.registerTool(
    'manage_sitemaps',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'manage_sitemaps'),
      title: 'Manage sitemaps',
      description: 'All-in-one tool to manage sitemaps (list, get details, submit, delete).',
      inputSchema: z.object({
        site_url: z.string().describe(SITE_URL_DESCRIPTION),
        action: z.string().describe('The action to perform (list, details, submit, delete).'),
        sitemap_url: z.string().nullish().describe(
          'The full URL of the sitemap (required for details, submit, delete). Explicit null means omitted.',
        ),
        sitemap_index: z.string().nullish().describe(
          'Optional sitemap index URL for listing child sitemaps (only used with \'list\' action). Explicit null means omitted.',
        ),
      }),
    },
    async ({ site_url, action, sitemap_url, sitemap_index }) => {
      try {
        const normalized = action.toLowerCase().trim() as 'list' | 'details' | 'submit' | 'delete';
        const validActions = ['list', 'details', 'submit', 'delete'];

        if (!validActions.includes(normalized)) {
          return errorResult(
            `Invalid action: ${action}. Please use one of: ${validActions.join(', ')}`,
          );
        }

        if ((normalized === 'details' || normalized === 'submit' || normalized === 'delete') && !sitemap_url) {
          return errorResult(`The ${normalized} action requires a sitemap_url parameter.`);
        }

        switch (normalized) {
          case 'list':
            return listSitemapsEnhanced(svc, site_url, sitemap_index);
          case 'details':
            return getSitemapDetails(svc, site_url, sitemap_url as string);
          case 'submit':
            return submitSitemap(svc, site_url, sitemap_url as string);
          case 'delete':
            return deleteSitemap(svc, site_url, sitemap_url as string);
        }
      } catch (e) {
        return errorResult(`Error managing sitemaps: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
