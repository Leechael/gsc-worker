/**
 * M2 smoke test: exercises all 21 tools against a running server.
 *
 * Usage:
 *   MCP_URL=http://localhost:3001/mcp MCP_AUTH_TOKEN=... npx tsx scripts/smoke.ts \
 *     --site sc-domain:example.com --page https://example.com/
 *
 * Behind Cloudflare Access, add a service token:
 *   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... MCP_URL=https://gsc-mcp.example.com/mcp \
 *     npx tsx scripts/smoke.ts --site ...
 *
 * Expects TOOL_TIER=read: write/destructive tools must refuse with
 * tier guidance flagged isError:true.
 *
 * Strict assertions (review P2-8, residual round): a success must carry a
 * valid tools/call result (result.content[0].text, non-empty) — a bare HTTP
 * 200 with '{}' does not pass. 'error' cases must match a specific message
 * (via `match`), not just any RPC error. 'api400' accepts either success or
 * a Google-side 400 (data-dependent cases like sitemap_index on a non-index).
 */
import { mcpAuthHeaders } from './mcp-auth-headers.js';

const url = process.env.MCP_URL ?? 'http://localhost:3001/mcp';
const authHeaders = mcpAuthHeaders();
const site = arg('site') ?? 'sc-domain:grokbotsdirectory.com';
const page = arg('page') ?? 'https://grokbotsdirectory.com/';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let id = 0;
interface CallOutcome {
  httpOk: boolean;
  rpcError: string | null;    // JSON-RPC error object, serialized
  toolErrored: boolean;       // result.isError or top-level "error" in the text payload
  gated: boolean;             // tier-gate guidance
  detail: string;             // inner text or transport error
  validResult: boolean;       // well-formed tools/call result with non-empty text
}

async function call(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  id++;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...authHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch (e) {
    return { httpOk: false, rpcError: null, toolErrored: true, gated: false, detail: String(e), validResult: false };
  }
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, unknown>;
  } catch {
    return { httpOk: res.ok, rpcError: null, toolErrored: true, gated: false, detail: `unparseable response: ${text.slice(0, 200)}`, validResult: false };
  }
  if (data.error) {
    return { httpOk: res.ok, rpcError: JSON.stringify(data.error).slice(0, 200), toolErrored: true, gated: false, detail: '', validResult: false };
  }
  const result = data.result as Record<string, unknown> | undefined;
  const content = result?.content;
  const first = Array.isArray(content) && content.length > 0
    ? (content[0] as Record<string, unknown>)
    : undefined;
  // Require a genuine non-empty string text field (review: String() would
  // have masked a missing/wrong-typed text).
  const inner = typeof first?.text === 'string' ? first.text : '';
  const validResult = res.ok && typeof first?.text === 'string' && inner.length > 0;
  const gated = /Safety:|requires the 'webmasters' scope/.test(inner);
  let toolErrored = result?.isError === true;
  try {
    const parsed: unknown = JSON.parse(inner);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) toolErrored = true;
  } catch {
    if (inner.startsWith('Error')) toolErrored = true;
  }
  return { httpOk: res.ok, rpcError: null, toolErrored, gated, detail: inner.slice(0, 400), validResult };
}

interface Case {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  expect: 'ok' | 'gate' | 'error' | 'api400';
  /** For 'error': detail must match. For 'ok': when present, detail must match. */
  match?: RegExp;
}

const CASES: Case[] = [
  { label: 'get_capabilities', tool: 'get_capabilities', args: {}, expect: 'ok', match: /SCOPE TIER/ },
  { label: 'get_creator_info', tool: 'get_creator_info', args: {}, expect: 'ok', match: /Amin/ },
  { label: 'reauthenticate', tool: 'reauthenticate', args: {}, expect: 'ok', match: /npm run auth/ },
  { label: 'list_properties', tool: 'list_properties', args: {}, expect: 'ok', match: /"properties"/ },
  { label: 'get_site_details', tool: 'get_site_details', args: { site_url: site }, expect: 'ok', match: /permission_level/ },
  { label: 'add_site(gate)', tool: 'add_site', args: { site_url: 'https://example.com/' }, expect: 'gate' },
  { label: 'delete_site(gate)', tool: 'delete_site', args: { site_url: 'https://example.com/' }, expect: 'gate' },
  { label: 'get_search_analytics', tool: 'get_search_analytics', args: { site_url: site, days: 7, row_limit: 5 }, expect: 'ok', match: /"rows"/ },
  {
    label: 'get_search_analytics(hour reject)',
    tool: 'get_search_analytics',
    args: { site_url: site, dimensions: 'hour' },
    expect: 'error',
    match: /dimension is only supported by get_advanced_search_analytics/,
  },
  { label: 'get_performance_overview', tool: 'get_performance_overview', args: { site_url: site, days: 7 }, expect: 'ok', match: /"totals"/ },
  {
    label: 'get_advanced_search_analytics',
    tool: 'get_advanced_search_analytics',
    args: { site_url: site, days: 7, dimensions: 'query', row_limit: 10, search_type: 'web' },
    expect: 'ok',
    match: /"pagination"/,
  },
  {
    label: 'get_advanced_search_analytics(googleNews wire value)',
    tool: 'get_advanced_search_analytics',
    args: { site_url: site, days: 7, search_type: 'GOOGLENEWS' },
    expect: 'error',
    match: /GOOGLE_NEWS/, // our validation maps the wire value; Google itself rejects query grouping
  },
  {
    label: 'get_advanced_search_analytics(hour>10d reject)',
    tool: 'get_advanced_search_analytics',
    args: { site_url: site, dimensions: 'query,hour', data_state: 'hourly_all' },
    expect: 'error',
    match: /at most 10 days/,
  },
  {
    label: 'get_advanced_search_analytics(hourly_all w/o hour reject)',
    tool: 'get_advanced_search_analytics',
    args: { site_url: site, data_state: 'hourly_all' },
    expect: 'error',
    match: /only valid when grouping/,
  },
  {
    label: 'compare_search_periods',
    tool: 'compare_search_periods',
    args: {
      site_url: site,
      period1_start: '2026-10-05', period1_end: '2026-10-11',
      period2_start: '2026-09-28', period2_end: '2026-10-04',
      limit: 5,
    },
    expect: 'ok',
    match: /"comparison"/,
  },
  { label: 'get_search_by_page_query', tool: 'get_search_by_page_query', args: { site_url: site, page_url: page, days: 28 }, expect: 'ok' },
  { label: 'inspect_url_enhanced', tool: 'inspect_url_enhanced', args: { site_url: site, page_url: page }, expect: 'ok', match: /"verdict"/ },
  { label: 'batch_url_inspection', tool: 'batch_url_inspection', args: { site_url: site, urls: page }, expect: 'ok', match: /"results"/ },
  { label: 'check_indexing_issues', tool: 'check_indexing_issues', args: { site_url: site, urls: page }, expect: 'ok', match: /"summary"/ },
  { label: 'get_sitemaps', tool: 'get_sitemaps', args: { site_url: site }, expect: 'ok' },
  { label: 'list_sitemaps_enhanced', tool: 'list_sitemaps_enhanced', args: { site_url: site }, expect: 'ok', match: /"sitemaps"/ },
  // Data-dependent: 400 from Google unless that URL is a real sitemap index.
  { label: 'list_sitemaps_enhanced(sitemap_index)', tool: 'list_sitemaps_enhanced', args: { site_url: site, sitemap_index: `${page}sitemap.xml` }, expect: 'api400' },
  { label: 'get_sitemap_details', tool: 'get_sitemap_details', args: { site_url: site, sitemap_url: `${page}sitemap.xml` }, expect: 'ok', match: /"content_breakdown"/ },
  { label: 'submit_sitemap(gate)', tool: 'submit_sitemap', args: { site_url: site, sitemap_url: `${page}sitemap.xml` }, expect: 'gate' },
  { label: 'delete_sitemap(gate)', tool: 'delete_sitemap', args: { site_url: site, sitemap_url: `${page}sitemap.xml` }, expect: 'gate' },
  { label: 'manage_sitemaps(list)', tool: 'manage_sitemaps', args: { site_url: site, action: 'list' }, expect: 'ok', match: /"sitemaps"/ },
  { label: 'manage_sitemaps(submit, gate)', tool: 'manage_sitemaps', args: { site_url: site, action: 'submit', sitemap_url: `${page}sitemap.xml` }, expect: 'gate' },
  { label: 'manage_sitemaps(delete, gate)', tool: 'manage_sitemaps', args: { site_url: site, action: 'delete', sitemap_url: `${page}sitemap.xml` }, expect: 'gate' },
  { label: 'manage_sitemaps(bogus action)', tool: 'manage_sitemaps', args: { site_url: site, action: 'bogus' }, expect: 'error', match: /Invalid action/ },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const out = await call(c.tool, c.args);
  let good: boolean;
  switch (c.expect) {
    case 'gate':
      // A tier refusal is a tool failure (isError:true) carrying upgrade guidance.
      good = out.validResult && out.gated && out.toolErrored;
      break;
    case 'error':
      // Expected tool-level rejection: must be a well-formed tools/call result
      // (not a transport string that happens to match) carrying the specific
      // error text.
      good = out.validResult && out.toolErrored && (c.match ? c.match.test(out.detail) : true);
      break;
    case 'api400':
      // Data-dependent case: either a valid success, or a valid tools/call
      // result whose text reports a Google-side 400. Transport-level 503s and
      // non-JSON bodies never qualify (review, final round).
      good = out.validResult && !out.toolErrored && (!c.match || c.match.test(out.detail)) ||
        (out.validResult && out.toolErrored && !out.rpcError && /HTTP 400|Bad Request/i.test(out.detail));
      break;
    default: // 'ok'
      good = out.validResult && !out.toolErrored && (!c.match || c.match.test(out.detail));
  }
  if (good) pass++;
  else fail++;
  console.log(`${good ? '✅' : '❌'} ${c.label}`);
  if (!good) {
    console.log(`   rpcError=${out.rpcError} toolErrored=${out.toolErrored} validResult=${out.validResult}`);
    if (out.detail) console.log(`   ${out.detail.slice(0, 300)}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
