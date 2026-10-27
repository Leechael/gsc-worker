/**
 * Seznam Webmaster tools (seznam_*). Registered (via ./index.ts) only when
 * SEZNAM_API_KEY yields at least one site key. Read tools work at every scope
 * tier; seznam_reindex_url needs the write tier (TOOL_TIER=write), using the
 * same tier order as the Google tools. The API has no delete operations.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ScopeTier } from '../../lib/config.js';
import { isValidISODate } from '../../lib/dates.js';
import type { ServerServices } from '../../mcp/context.js';
import { errorResult, jsonResult } from '../../tools/helpers.js';
import { engineTierGate, type EngineToolInfo } from '../types.js';
import { SEZNAM_LIMITS, SeznamApiError, SeznamWebmasterClient, type SeznamClientOptions, type SeznamResult } from './client.js';
import { parseSeznamSites, selectSite, type SeznamSite } from './sites.js';
import { toolAnnotations } from '../../mcp/tool-annotations.js';

const KEY_HELP =
  'Generate a key in Seznam Webmaster (https://reporter.seznam.cz/wm/): open the site, go to the API section and create an access key ' +
  '(read, or write for seznam_reindex_url). Store it in SEZNAM_API_KEY with `npx wrangler secret put SEZNAM_API_KEY`: ' +
  'the key itself for one site, or a JSON object {"site":"key"} for several.';

export const SEZNAM_LABEL = 'Seznam Webmaster';

/** Tools and the tier each needs, for get_capabilities and the README. */
export const SEZNAM_TOOLS: readonly EngineToolInfo[] = [
  { name: 'seznam_list_sites', tier: 'read', summary: 'Configured Seznam sites (labels only, never keys)' },
  { name: 'seznam_get_site', tier: 'read', summary: 'Index counts by category plus history and web server (GET /web)' },
  { name: 'seznam_get_documents', tier: 'read', summary: 'Index counts and sample URLs by category (GET /web/documents)' },
  { name: 'seznam_get_documents_history', tier: 'read', summary: 'Daily index counts by category (GET /web/documents-history)' },
  { name: 'seznam_get_document', tier: 'read', summary: 'Index and crawl detail for one URL (GET /web/document)' },
  { name: 'seznam_reindex_url', tier: 'write', idempotent: false, summary: 'Ask Seznam to recrawl one URL; 500 per site per day; key needs write rights (POST /web/document/reindex)' },
];

const NO_DATA =
  'Seznam answered 204: the request succeeded but the data is not available yet. Newly added sites usually get data within 24 hours; ' +
  'Seznam Webmaster is in beta and data can be missing for some periods.';

/** Same gate as engineTierGate(), plus the Seznam-specific key-rights hint. */
export function seznamTierGate(tier: ScopeTier, tool: string, required: 'write' | 'destructive'): string | null {
  const gate = engineTierGate(tier, tool, required, SEZNAM_LABEL);
  return gate && `${gate}\nThe Seznam key for the site also needs write rights.`;
}

export function seznamErrorText(prefix: string, e: unknown, site?: SeznamSite, operation: 'read' | 'reindex' = 'read'): string {
  const where = site ? ` (site ${site.label})` : '';
  if (e instanceof SeznamApiError) {
    switch (e.status) {
      case 401:
        return `Error: Seznam rejected the API key${where} (HTTP 401). ${KEY_HELP} Details: ${e.message}`;
      case 403:
        return operation === 'reindex'
          ? `Error: Seznam denied the reindex request${where} (HTTP 403). Reindexing needs a key with write rights (administrator or write access). Details: ${e.message}`
          : `Error: Seznam denied access${where} (HTTP 403). Details: ${e.message}`;
      case 404:
        return `Error: ${prefix}${where}: Seznam found no data for the site or page (HTTP 404). Details: ${e.message}`;
      case 429:
        return `Error: Seznam rate limit hit while ${prefix}${where} (HTTP 429): ${SEZNAM_LIMITS}. Try again later. Details: ${e.message}`;
      case 502:
      case 503:
        return `Error: Seznam Webmaster is unavailable (HTTP ${e.status}); try again later.`;
      case 0:
        return `Error: ${prefix}: ${e.message}`;
      default:
        return `Error: ${prefix}${where}: ${e.message} (HTTP ${e.status})`;
    }
  }
  return `Error: ${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------- normalization ----------

interface WebUrl { count?: number; urls?: string[] }
type WebDocuments = Record<string, WebUrl | undefined>;
interface WebHistory { date?: string; counts?: Record<string, number> }
interface Web { documents?: WebDocuments; history?: WebHistory[]; webserver?: string }
interface DocumentInfo {
  url?: string;
  title?: string;
  indexTimestamp?: number;
  downloadTimestamp?: number;
  isIndexed?: boolean;
  isError?: boolean;
  isRedirect?: boolean;
  meta?: { author?: string; desc?: string; keywords?: string };
  openGraphData?: { name?: string; content?: string }[];
  responseHeaders?: { name?: string; value?: string; content?: string }[];
}

export const CATEGORIES = ['doc_count', 'content', 'redirect', 'index', 'error'] as const;

function documents(d: WebDocuments | undefined, urlLimit: number, only?: readonly string[] | null) {
  const out: Record<string, { count: number | null; urls_returned: number; urls_total_in_sample: number; urls: string[] }> = {};
  for (const [category, v] of Object.entries(d ?? {})) {
    if (only && !only.includes(category)) continue;
    const urls = v?.urls ?? [];
    out[category] = { count: v?.count ?? null, urls_returned: Math.min(urls.length, urlLimit), urls_total_in_sample: urls.length, urls: urls.slice(0, urlLimit) };
  }
  return out;
}

function history(h: WebHistory[] | undefined) {
  return (h ?? []).map((p) => ({ date: p.date ?? null, counts: p.counts ?? {} }));
}

// ---------- tools ----------

const siteArg = z.string().nullish().describe(
  'Configured Seznam site (see seznam_list_sites), e.g. example.cz. Optional when only one site is configured, or when url identifies the site.',
);
const dateArg = (which: 'from' | 'to') => z.string().nullish().describe(`date_${which} as YYYY-MM-DD (optional).`);

type ToolResult = ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>;

/** One client per MCP server instance. `clientOptions` is injectable for tests (mocked fetch, no retry delay). */
export function registerSeznamTools(server: McpServer, svc: ServerServices, clientOptions: SeznamClientOptions = {}): void {
  const { sites, error: configError } = parseSeznamSites(svc.config);
  if (sites.length === 0) return;
  const client = new SeznamWebmasterClient(clientOptions);

  const withSite = async (
    prefix: string,
    site: string | null | undefined,
    url: string | null | undefined,
    fn: (s: SeznamSite) => Promise<unknown>,
    operation: 'read' | 'reindex' = 'read',
  ): Promise<ToolResult> => {
    let chosen: SeznamSite;
    try {
      chosen = selectSite(sites, site, url);
    } catch (e) {
      return errorResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return jsonResult(await fn(chosen));
    } catch (e) {
      return errorResult(seznamErrorText(prefix, e, chosen, operation));
    }
  };
  const noData = (site: SeznamSite) => ({ site: site.label, data_available: false, message: NO_DATA });
  const unwrap = <T>(r: SeznamResult<T>): T | null => (r.noData ? null : r.data);

  server.registerTool(
    'seznam_list_sites',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_list_sites'),
      title: 'Seznam: configured sites',
      description: 'List the Seznam Webmaster sites this server has API keys for (labels only; keys are never shown). Use the label as `site` in the other seznam_* tools.',
      inputSchema: z.object({}),
    },
    async () => jsonResult({
      count: sites.length,
      sites: sites.map((s) => ({ site: s.label, ...(s.host === null ? { note: 'SEZNAM_API_KEY (single key)' } : {}) })),
      ...(configError ? { warning: configError } : {}),
      limits: SEZNAM_LIMITS,
    }),
  );

  server.registerTool(
    'seznam_get_site',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_get_site'),
      title: 'Seznam: site overview',
      description:
        'Everything Seznam Webmaster currently has for the site (GET /web): page counts per category (doc_count: known to the robot, content: downloaded, ' +
        'redirect, index: in the index, error) with URL samples, plus the daily history of counts. Seznam provides no search query or traffic data.',
      inputSchema: z.object({
        site: siteArg,
        url_limit: z.number().int().min(0).max(1000).nullish().describe('URLs to return per category from the sample (0-1000, default 20).'),
      }),
    },
    async (a) => withSite('getting the Seznam site overview', a.site, null, async (s) => {
      const d = unwrap(await client.request<Web>('/web', s.key));
      if (!d) return noData(s);
      return {
        site: s.label,
        data_available: true,
        ...(d.webserver ? { webserver: d.webserver } : {}),
        documents: documents(d.documents, a.url_limit ?? 20),
        history: history(d.history),
      };
    }),
  );

  server.registerTool(
    'seznam_get_documents',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_get_documents'),
      title: 'Seznam: page counts and URL samples',
      description:
        'Current page counts per category with a random sample of up to 1,000 URLs each (GET /web/documents). ' +
        'Categories: doc_count (known to the robot), content (downloaded), redirect, index (in the index), error. Use category=error to list failing URLs.',
      inputSchema: z.object({
        site: siteArg,
        categories: z.array(z.enum(CATEGORIES)).min(1).nullish().describe('Only these categories (default all).'),
        url_limit: z.number().int().min(0).max(1000).nullish().describe('URLs to return per category (0-1000, default 100).'),
      }),
    },
    async (a) => withSite('getting Seznam documents', a.site, null, async (s) => {
      const d = unwrap(await client.request<WebDocuments>('/web/documents', s.key));
      if (!d) return noData(s);
      return { site: s.label, data_available: true, documents: documents(d, a.url_limit ?? 100, a.categories ?? null) };
    }),
  );

  server.registerTool(
    'seznam_get_documents_history',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_get_documents_history'),
      title: 'Seznam: page count history',
      description:
        'Daily page counts over time (GET /web/documents-history): error, doc_count (known to the robot), content (downloaded, content known), ' +
        'downloaded (deprecated, replaced by doc_count), redirected, indexed.',
      inputSchema: z.object({ site: siteArg, date_from: dateArg('from'), date_to: dateArg('to') }),
    },
    async (a) => {
      for (const [name, v] of [['date_from', a.date_from], ['date_to', a.date_to]] as const) {
        if (v != null && !isValidISODate(v)) return errorResult(`Error: ${name} must be a date in YYYY-MM-DD format, got '${v}'.`);
      }
      if (a.date_from && a.date_to && a.date_from > a.date_to) return errorResult('Error: date_from must not be after date_to.');
      return withSite('getting Seznam document history', a.site, null, async (s) => {
        const d = unwrap(await client.request<WebHistory[]>('/web/documents-history', s.key, { query: { date_from: a.date_from, date_to: a.date_to } }));
        if (!d) return noData(s);
        return { site: s.label, data_available: true, history: history(d) };
      });
    },
  );

  server.registerTool(
    'seznam_get_document',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_get_document'),
      title: 'Seznam: one page',
      description:
        'What Seznam knows about one URL (GET /web/document): whether it is indexed, an error or a redirect, title, meta tags, Open Graph data, ' +
        'the response headers the robot saw, and the index/download timestamps (raw values from Seznam).',
      inputSchema: z.object({ url: z.string().url().describe('Absolute URL of the page.'), site: siteArg }),
    },
    async (a) => withSite('getting the Seznam page details', a.site, a.url, async (s) => {
      const d = unwrap(await client.request<DocumentInfo>('/web/document', s.key, { query: { url: a.url } }));
      if (!d) return noData(s);
      return {
        site: s.label,
        data_available: true,
        url: d.url ?? a.url,
        title: d.title ?? null,
        is_indexed: d.isIndexed ?? null,
        is_error: d.isError ?? null,
        is_redirect: d.isRedirect ?? null,
        index_timestamp: d.indexTimestamp ?? null,
        download_timestamp: d.downloadTimestamp ?? null,
        meta: d.meta ?? {},
        open_graph: (d.openGraphData ?? []).map((o) => ({ name: o.name ?? null, content: o.content ?? null })),
        response_headers: (d.responseHeaders ?? []).map((h) => ({ name: h.name ?? null, value: h.value ?? h.content ?? null })),
      };
    }),
  );

  server.registerTool(
    'seznam_reindex_url',
    {
      annotations: toolAnnotations(SEZNAM_TOOLS, 'seznam_reindex_url'),
      title: 'Seznam: request reindexing',
      description:
        'Ask Seznam to reindex one URL (POST /web/document/reindex). Needs a key with write rights; Seznam allows at most 500 reindex requests a day. ' +
        'Requires the write tier (TOOL_TIER=write).',
      inputSchema: z.object({ url: z.string().url().describe('Absolute URL of the page.'), site: siteArg }),
    },
    async (a) => {
      const gate = seznamTierGate(svc.config.scopeTier, 'seznam_reindex_url', 'write');
      if (gate) return errorResult(gate);
      return withSite('requesting Seznam reindexing', a.site, a.url, async (s) => {
        await client.request<void>('/web/document/reindex', s.key, { method: 'POST', query: { url: a.url } });
        return { site: s.label, requested: true, url: a.url };
      }, 'reindex');
    },
  );
}
