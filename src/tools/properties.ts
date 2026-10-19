import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../mcp/context.js';
import { GscApiError } from '../lib/gsc-client.js';
import { errorText, errorResult, jsonResult, textResult, tierGateMessage } from './helpers.js';

interface SiteListResponse {
  siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
}

interface SiteDetailsResponse {
  permissionLevel?: string;
  siteVerificationInfo?: {
    verificationState?: string;
    verifiedUser?: string;
    verificationMethod?: string;
  };
  ownershipInfo?: {
    owner?: string;
    verificationMethod?: string;
  };
}

/** Map GscApiError to the Python版's HttpError branch messages (add/remove site). */
function siteMutationError(e: unknown, action: 'adding' | 'removing', siteUrl: string): string {
  if (e instanceof GscApiError) {
    const errorCode = e.status;
    const errorMessage = e.message;
    const errorReason = e.reason ?? '';
    if (errorCode === 409 && action === 'adding') {
      return `Site ${siteUrl} is already added to Search Console.`;
    }
    if (errorCode === 404 && action === 'removing') {
      return `Site ${siteUrl} was not found in Search Console.`;
    }
    if (errorCode === 403) {
      if (errorReason === 'forbidden') {
        return action === 'adding'
          ? `Error: You don't have permission to add this site. Please verify ownership first.`
          : `Error: You don't have permission to remove this site.`;
      }
      if (errorReason === 'quotaExceeded') {
        return `Error: API quota exceeded. Please try again later.`;
      }
      return `Error: Permission denied. ${errorMessage}`;
    }
    if (errorCode === 400) {
      if (errorReason === 'invalidParameter') {
        return `Error: Invalid site URL format. Please check the URL format and try again.`;
      }
      return `Error: Bad request. ${errorMessage}`;
    }
    if (errorCode === 401) {
      return `Error: Unauthorized. Please check your credentials.`;
    }
    if (errorCode === 429) {
      return `Error: Too many requests. Please try again later.`;
    }
    if (errorCode === 500) {
      return `Error: Internal server error from Google Search Console API. Please try again later.`;
    }
    if (errorCode === 503) {
      return `Error: Service unavailable. Google Search Console API is currently down. Please try again later.`;
    }
    return `Error ${action === 'adding' ? 'adding' : 'removing'} site (HTTP ${errorCode}): ${errorMessage}`;
  }
  return `Error ${action} site: ${e instanceof Error ? e.message : String(e)}`;
}

export function registerPropertiesTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'list_properties',
    {
      title: 'List GSC properties',
      description:
        'List all Google Search Console (GSC) properties and sites the account has access to. ' +
        'Always call this first to get the exact site_url needed for other tools.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const data = await svc.gsc.request<SiteListResponse>('/webmasters/v3/sites');
        const sites = data.siteEntry ?? [];
        if (sites.length === 0) {
          return jsonResult({ count: 0, properties: [] });
        }
        return jsonResult({
          count: sites.length,
          properties: sites.map((s) => ({
            site_url: s.siteUrl ?? 'Unknown',
            permission_level: s.permissionLevel ?? 'Unknown',
          })),
        });
      } catch (e) {
        return errorResult(errorText('retrieving properties', e));
      }
    },
  );

  server.registerTool(
    'add_site',
    {
      title: 'Add a GSC property',
      description:
        'Add a site to your Search Console properties. ' +
        'site_url must be an exact match e.g. https://example.com, or https://www.example.com, ' +
        'or https://subdomain.example.com/path/, for domain properties use format: sc-domain:example.com.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'The URL of the site to add (must be exact match e.g. https://example.com, or https://www.example.com, or https://subdomain.example.com/path/, for domain properties use format: sc-domain:example.com)',
        ),
      }),
    },
    async ({ site_url }) => {
      const gate = tierGateMessage(svc.config.scopeTier, 'add_site', 'destructive');
      if (gate !== null) return errorResult(gate);
      try {
        // sites.add is a PUT and returns an empty body on success (review P1-3).
        await svc.gsc.request<void>(
          `/webmasters/v3/sites/${encodeURIComponent(site_url)}`,
          { method: 'PUT' },
        );
        return textResult(`Site ${site_url} has been added to Search Console.`);
      } catch (e) {
        const message = siteMutationError(e, 'adding', site_url);
        // 409 means the site is already added — the requested state already holds.
        if (e instanceof GscApiError && e.status === 409) return textResult(message);
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    'delete_site',
    {
      title: 'Remove a GSC property',
      description:
        'Remove a site from your Search Console properties. ' +
        'site_url must be an exact match e.g. https://example.com, or https://www.example.com, ' +
        'or https://subdomain.example.com/path/, for domain properties use format: sc-domain:example.com.',
      inputSchema: z.object({
        site_url: z.string().describe(
          'The URL of the site to remove (must be exact match e.g. https://example.com, or https://www.example.com, or https://subdomain.example.com/path/, for domain properties use format: sc-domain:example.com)',
        ),
      }),
    },
    async ({ site_url }) => {
      const gate = tierGateMessage(svc.config.scopeTier, 'delete_site', 'destructive');
      if (gate !== null) return errorResult(gate);
      try {
        await svc.gsc.request<unknown>(`/webmasters/v3/sites/${encodeURIComponent(site_url)}`, {
          method: 'DELETE',
        });
        return textResult(`Site ${site_url} has been removed from Search Console.`);
      } catch (e) {
        const message = siteMutationError(e, 'removing', site_url);
        // 404 means the site is already gone — the requested state already holds.
        if (e instanceof GscApiError && e.status === 404) return textResult(message);
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    'get_site_details',
    {
      title: 'Get GSC property details',
      description:
        'Get detailed information about a specific Search Console property ' +
        '(permission level, verification state, ownership).',
      inputSchema: z.object({
        site_url: z.string().describe(
          'Exact GSC property URL from list_properties (e.g. "https://example.com/" or "sc-domain:example.com"). Domain properties cover all subdomains — use the domain property as site_url and filter by page to analyze a specific subdomain.',
        ),
      }),
    },
    async ({ site_url }) => {
      try {
        const siteInfo = await svc.gsc.request<SiteDetailsResponse>(
          `/webmasters/v3/sites/${encodeURIComponent(site_url)}`,
        );
        const result: Record<string, unknown> = {
          site_url,
          permission_level: siteInfo.permissionLevel ?? 'Unknown',
        };
        if (siteInfo.siteVerificationInfo !== undefined) {
          const verifyInfo = siteInfo.siteVerificationInfo;
          result.verification = {
            state: verifyInfo.verificationState ?? 'Unknown',
            verified_user: verifyInfo.verifiedUser ?? null,
            method: verifyInfo.verificationMethod ?? null,
          };
        }
        if (siteInfo.ownershipInfo !== undefined) {
          const ownerInfo = siteInfo.ownershipInfo;
          result.ownership = {
            owner: ownerInfo.owner ?? 'Unknown',
            verification_method: ownerInfo.verificationMethod ?? null,
          };
        }
        return jsonResult(result);
      } catch (e) {
        return errorResult(errorText('retrieving site details', e, site_url));
      }
    },
  );
}
