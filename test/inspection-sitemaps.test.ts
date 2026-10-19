/** Inspection payload shape and sitemap error counts returned as strings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { registerInspectionTools } from '../src/tools/inspection.js';
import { registerSitemapsTools } from '../src/tools/sitemaps.js';

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

function services(respond: (url: string) => unknown): ServerServices {
  const tokenProvider = new TokenProvider(
    { clientId: 'i', clientSecret: 's', refreshToken: 'r', scopes: [] },
    (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch,
  );
  const fetchImpl = (async (input: unknown) =>
    new Response(JSON.stringify(respond(String(input))), { status: 200 })) as typeof fetch;
  return { config: parseConfig(), tokenProvider, gsc: new GscClient({ tokenProvider, fetchImpl }) };
}

function toolsOf(server: McpServer): Record<string, { executor: (args: unknown, ctx: unknown) => Promise<ToolResult> }> {
  return (server as unknown as { _registeredTools: Record<string, { executor: (args: unknown, ctx: unknown) => Promise<ToolResult> }> })._registeredTools;
}

const INSPECTION = {
  inspectionResult: {
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      sitemap: ['https://example.com/sitemap.xml', 'https://example.com/sitemap-pages.xml'],
      referringUrls: ['https://example.com/a'],
    },
    richResultsResult: {
      verdict: 'FAIL',
      detectedItems: [{
        richResultType: 'Merchant listings',
        items: [{
          name: 'Widget',
          issues: [{ severity: 'ERROR', issueMessage: 'Missing field "image"' }],
        }],
      }],
    },
  },
};

test('inspect_url_enhanced keeps referring sitemaps and nested rich-result issues', async () => {
  const svc = services(() => INSPECTION);
  const server = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(server, svc);
  const result = await toolsOf(server).inspect_url_enhanced!.executor({
    site_url: 'sc-domain:example.com',
    page_url: 'https://example.com/widget',
    language_code: 'en-US',
    include_amp: false,
  }, {});
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as {
    referring_sitemaps: string[];
    rich_results: { verdict: string; issues: { type: string; item: string; severity: string; message: string }[] };
  };
  assert.deepEqual(body.referring_sitemaps, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap-pages.xml',
  ]);
  assert.equal(body.rich_results.verdict, 'FAIL');
  assert.equal(body.rich_results.issues[0]!.message, 'Missing field "image"');
  assert.equal(body.rich_results.issues[0]!.type, 'Merchant listings');
  assert.equal(body.rich_results.issues[0]!.item, 'Widget');
  assert.equal(body.rich_results.issues[0]!.severity, 'ERROR');
});

test('batch_url_inspection reports a failing rich result instead of dropping it', async () => {
  const svc = services(() => INSPECTION);
  const server = new McpServer({ name: 't', version: '0' });
  registerInspectionTools(server, svc);
  const result = await toolsOf(server).batch_url_inspection!.executor({
    site_url: 'sc-domain:example.com',
    urls: 'https://example.com/widget',
  }, {});
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as {
    results: {
      index_verdict: string;
      referring_sitemaps: string[];
      rich_results: { verdict: string; issues: { message: string }[] } | string | null;
    }[];
  };
  const row = body.results[0]!;
  assert.equal(row.index_verdict, 'PASS');
  assert.equal(typeof row.rich_results, 'object');
  assert.notEqual(row.rich_results, null);
  const rich = row.rich_results as { verdict: string; issues: { message: string }[] };
  assert.equal(rich.verdict, 'FAIL');
  assert.equal(rich.issues[0]!.message, 'Missing field "image"');
  assert.deepEqual(row.referring_sitemaps, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap-pages.xml',
  ]);
});

test('sitemap error and warning counts compare correctly when the API sends strings', async () => {
  const svc = services(() => ({
    sitemap: [
      {
        path: 'https://example.com/sitemap.xml',
        errors: '2',
        warnings: '0',
        contents: [{ type: 'web', submitted: 15 }],
      },
      {
        path: 'https://example.com/other.xml',
        errors: '0',
        warnings: '3',
        contents: [{ type: 'web', submitted: 4 }],
      },
    ],
  }));
  const server = new McpServer({ name: 't', version: '0' });
  registerSitemapsTools(server, svc);
  const result = await toolsOf(server).get_sitemaps!.executor({ site_url: 'https://example.com/' }, {});
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0]!.text) as {
    sitemaps: { path: string; status: string; errors: number; warnings: number }[];
  };
  assert.equal(body.sitemaps[0]!.status, 'Has errors');
  assert.equal(body.sitemaps[0]!.errors, 2);
  assert.equal(body.sitemaps[1]!.status, 'Has warnings');
  assert.equal(body.sitemaps[1]!.warnings, 3);
});
