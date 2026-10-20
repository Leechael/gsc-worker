import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerServices } from '../mcp/context.js';
import { scopesCover } from '../lib/google-oauth/google.js';
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
      const status = await svc.tokenProvider.status();
      const notAuthenticated =
        '❌ Not authenticated — on Cloudflare Workers with the GSC_TOKENS KV binding, open https://<worker-host>/auth/google in a browser. ' +
        'Otherwise run: npm run auth -- --scopes readonly --client-secrets <downloaded.json> --out gsc-credentials.json, ' +
        'then set GSC_CREDENTIALS_FILE (Node/Docker) or the three GOOGLE_* env vars / wrangler secrets.';
      let authStatus: string;
      if (!status.clientConfigured) {
        authStatus =
          status.source === 'none'
            ? `❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set.\n${notAuthenticated}`
            : `❌ A refresh token is present (source: ${status.source}), but GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set, ` +
              'so it cannot be used. Set them (wrangler secret put on Workers).';
      } else if (status.source === 'none') {
        authStatus = notAuthenticated;
      } else if (status.error) {
        authStatus = `⚠️ Credentials configured, but the Google token cannot be used:\n${status.error}`;
      } else {
        authStatus = '✅ Credentials configured — ready to use all tools in the current scope tier.';
      }
      if (status.source === 'kv' && status.stored && !scopesCover(status.stored.scope, svc.config.google.scopes)) {
        authStatus +=
          `\n⚠️ The stored grant (scope: ${status.stored.scope}) does not cover the configured GSC_SCOPES; ` +
          'tools needing the missing scope will fail. Re-authorize at https://<worker-host>/auth/google.';
      }
      const tokenSource = {
        kv: `kv (authorized in-Worker via /auth/google${status.stored ? `, stored ${status.stored.storedAt}` : ''}${status.stored?.email ? `, account ${status.stored.email}` : ''})`,
        env: 'env (GOOGLE_REFRESH_TOKEN)',
        none: 'none',
      }[status.source];

      const tier = svc.config.scopeTier;
      const lines: string[] = [
        'Google Search Console MCP Server (TypeScript)',
        '',
        `SCOPE TIER: ${tier} (GSC_SCOPES=${svc.config.google.scopes.includes('https://www.googleapis.com/auth/webmasters') ? 'full' : 'readonly'}${svc.config.allowDestructive ? ', GSC_ALLOW_DESTRUCTIVE=true' : ''})`,
        '',
        'AUTH STATUS:',
        authStatus,
        `TOKEN SOURCE: ${tokenSource}`,
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
        const notEnabled: string[] = [];
        if (tier === 'read') notEnabled.push('  - write tools: set GSC_SCOPES=full');
        notEnabled.push(
          tier === 'read'
            ? '  - destructive tools (add_site/delete_site/delete_sitemap): additionally set GSC_ALLOW_DESTRUCTIVE=true'
            : '  - destructive tools (add_site/delete_site/delete_sitemap): set GSC_ALLOW_DESTRUCTIVE=true',
        );
        lines.push('', 'Not enabled at the current tier:', ...notEnabled);
      }
      lines.push('', AEO_GEO_BOUNDARY, '');
      return textResult(lines.join('\n'));
    },
  );
}
