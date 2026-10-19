import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerServices } from '../mcp/context.js';
import { textResult } from './helpers.js';

const AEO_GEO_BOUNDARY = `
AEO/GEO CAPABILITY BOUNDARY:
- AI Overviews / AI Mode / multimodal performance data is available ONLY in the
  GSC web UI (Generative AI performance report) or via export. This MCP cannot
  access it — the Search Console API exposes no generative/AI fields.
- Do NOT infer AI exposure from searchAppearance or position values.
`.trim();

/** Tools available at each scope tier (plan §6.1). */
const TIER_TOOLS: Record<string, string[]> = {
  read: [
    'get_capabilities', 'get_creator_info', 'reauthenticate',
    'list_properties', 'get_site_details',
    'get_search_analytics', 'get_performance_overview', 'get_advanced_search_analytics',
    'compare_search_periods', 'get_search_by_page_query',
    'inspect_url_enhanced', 'batch_url_inspection', 'check_indexing_issues',
    'get_sitemaps', 'list_sitemaps_enhanced', 'get_sitemap_details',
  ],
  write: ['submit_sitemap', 'manage_sitemaps (action=submit)'],
  destructive: ['add_site', 'delete_site', 'delete_sitemap', 'manage_sitemaps (action=delete)'],
};

export function registerCapabilitiesTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'get_capabilities',
    {
      title: 'Capabilities & auth status',
      description:
        'Get a full list of available tools, current auth status, scope tier, and how to get started. ' +
        'ALWAYS call this first when asked what tools are available or how to get started. ' +
        'Also documents the AEO/GEO capability boundary (no AI Overview / AI Mode data via API).',
    },
    async () => {
      const authStatus = svc.tokenProvider.configured
        ? svc.tokenProvider.lastErrorMessage
          ? `⚠️ Credentials configured, but the last token refresh failed:\n${svc.tokenProvider.lastErrorMessage}`
          : '✅ Credentials configured — ready to use all tools in the current scope tier.'
        : '❌ Not authenticated — run: npm run auth -- --scopes readonly --client-secrets <下载的json> --out gsc-credentials.json, then set GSC_CREDENTIALS_FILE (本地/Docker) or the三个 GOOGLE_* env / wrangler secrets (Workers)';

      const tier = svc.config.scopeTier;
      const lines: string[] = [
        'Google Search Console MCP Server (TypeScript)',
        '',
        `SCOPE TIER: ${tier} (GSC_SCOPES=${svc.config.google.scopes.includes('https://www.googleapis.com/auth/webmasters') ? 'full' : 'readonly'}${svc.config.allowDestructive ? ', GSC_ALLOW_DESTRUCTIVE=true' : ''})`,
        '',
        'AUTH STATUS:',
        authStatus,
        '',
        'GETTING STARTED:',
        '1. Fix auth if needed (see AUTH STATUS).',
        '2. Call list_properties to see all your GSC sites and get the exact site_url for other tools.',
        '3. Use any tool below with the site_url from step 2.',
        '',
        'AVAILABLE TOOLS:',
        '',
        'Analytics & Reporting:',
        ...TIER_TOOLS.read!.filter((t) => !['get_capabilities', 'get_creator_info', 'reauthenticate', 'list_properties', 'get_site_details'].includes(t)).map((t) => `  - ${t}`),
        '',
        'Properties:',
        '  - list_properties: List all GSC sites/properties (start here)',
        '  - get_site_details: Verification and ownership details for a site',
        '',
        'URL Inspection & Indexing:',
        '  - inspect_url_enhanced: Detailed crawl/index status for a specific URL',
        '  - batch_url_inspection: Inspect multiple URLs at once',
        '  - check_indexing_issues: Check multiple URLs for indexing problems',
        '',
        'Sitemaps:',
        '  - get_sitemaps: List all sitemaps for a site',
        '  - list_sitemaps_enhanced: Detailed sitemap info including errors and warnings',
        '  - get_sitemap_details: Details for one sitemap',
      ];
      if (tier !== 'read') {
        lines.push('', 'Write (scope tier write):', ...TIER_TOOLS.write!.map((t) => `  - ${t}`));
      }
      if (tier === 'destructive') {
        lines.push('', 'Destructive (GSC_ALLOW_DESTRUCTIVE=true):', ...TIER_TOOLS.destructive!.map((t) => `  - ${t}`));
      } else {
        lines.push(
          '',
          'Not enabled at the current tier:',
          `  - write tools: set GSC_SCOPES=full`,
          `  - destructive tools (add_site/delete_site/delete_sitemap): additionally set GSC_ALLOW_DESTRUCTIVE=true`,
        );
      }
      lines.push('', AEO_GEO_BOUNDARY, '');
      return textResult(lines.join('\n'));
    },
  );
}
