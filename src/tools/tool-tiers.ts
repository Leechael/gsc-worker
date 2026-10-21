import type { ToolPolicy } from '../mcp/tool-annotations.js';

/**
 * Scope tier of every Google Search Console tool. Tool annotations are
 * derived from this table; test/tool-contracts.test.ts checks that the tier
 * gates in the tool code agree with it.
 */
export const GSC_TOOLS: readonly ToolPolicy[] = [
  { name: 'get_capabilities', tier: 'read' },
  { name: 'get_creator_info', tier: 'read' },
  { name: 'reauthenticate', tier: 'read' },
  { name: 'list_properties', tier: 'read' },
  { name: 'get_site_details', tier: 'read' },
  { name: 'get_search_analytics', tier: 'read' },
  { name: 'get_performance_overview', tier: 'read' },
  { name: 'get_advanced_search_analytics', tier: 'read' },
  { name: 'compare_search_periods', tier: 'read' },
  { name: 'get_search_by_page_query', tier: 'read' },
  { name: 'inspect_url_enhanced', tier: 'read' },
  { name: 'batch_url_inspection', tier: 'read' },
  { name: 'check_indexing_issues', tier: 'read' },
  { name: 'get_sitemaps', tier: 'read' },
  { name: 'list_sitemaps_enhanced', tier: 'read' },
  { name: 'get_sitemap_details', tier: 'read' },
  // sitemaps.submit is a PUT: resubmitting the same sitemap is a no-op.
  { name: 'submit_sitemap', tier: 'write', idempotent: true },
  // Gated destructive (GSC_ALLOW_DESTRUCTIVE) even though it adds rather than removes.
  { name: 'add_site', tier: 'destructive', idempotent: true },
  { name: 'delete_site', tier: 'destructive', idempotent: true },
  { name: 'delete_sitemap', tier: 'destructive', idempotent: true },
  // action=delete removes a sitemap; every action is idempotent.
  { name: 'manage_sitemaps', tier: 'destructive', idempotent: true },
];
