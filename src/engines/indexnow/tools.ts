/**
 * IndexNow MCP tools (indexnow_*). Registered only when INDEXNOW_KEY is set.
 * indexnow_submit_urls needs the write tier (GSC_SCOPES=full);
 * indexnow_check_key_file is read-only and only fetches your own key file.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../../mcp/context.js';
import { errorResult, jsonError, jsonResult } from '../../tools/helpers.js';
import { engineTierGate, parseHttpUrl, type EngineToolInfo } from '../types.js';
import { INDEXNOW_ENDPOINT, INDEXNOW_MAX_URLS, IndexNowClient, planSubmission, resolveKeyLocation, type IndexNowConfig } from './client.js';

export const INDEXNOW_LABEL = 'IndexNow';

export const INDEXNOW_TOOLS: readonly EngineToolInfo[] = [
  { name: 'indexnow_check_key_file', tier: 'read', summary: 'Check that the IndexNow key file is hosted on a site' },
  { name: 'indexnow_submit_urls', tier: 'write', summary: `Notify IndexNow engines (Bing, Yandex, Seznam, Naver, ...) of up to ${INDEXNOW_MAX_URLS} changed URLs on one host` },
];

export function registerIndexNowTools(server: McpServer, svc: ServerServices, cfg: IndexNowConfig, client: IndexNowClient): void {
  server.registerTool(
    'indexnow_submit_urls',
    {
      title: 'IndexNow: submit URLs',
      description:
        `Notify search engines that URLs were added, updated or deleted, via IndexNow (${INDEXNOW_ENDPOINT}). ` +
        'Participating engines share submissions with each other (Bing, Yandex, Seznam, Naver, Yep and others; not Google). ' +
        `Up to ${INDEXNOW_MAX_URLS} URLs per call, all on the same host; the host is taken from the URLs. ` +
        'The key file must be hosted on that host. A 200/202 answer means received, not indexed. Requires GSC_SCOPES=full.',
      inputSchema: z.object({
        urls: z.array(z.string().min(1)).min(1).max(INDEXNOW_MAX_URLS).describe('Absolute http(s) URLs on one host.'),
      }),
    },
    async ({ urls }) => {
      const gate = engineTierGate(svc.config.scopeTier, 'indexnow_submit_urls', 'write', INDEXNOW_LABEL);
      if (gate) return errorResult(gate);
      const plan = planSubmission(urls, cfg);
      if (!plan.ok) return errorResult(`Error: ${plan.error}`);
      const outcome = await client.submit(plan);
      const result = {
        host: plan.host,
        submitted: plan.urlList.length,
        key_file: plan.keyFileUrl.replace(cfg.key, '<INDEXNOW_KEY>'),
        http_status: outcome.status,
        message: outcome.message,
      };
      return outcome.ok ? jsonResult(result) : errorResult(`Error: ${outcome.message}`);
    },
  );

  server.registerTool(
    'indexnow_check_key_file',
    {
      title: 'IndexNow: check key file',
      description:
        'Check that the IndexNow key file for a site is publicly reachable and contains INDEXNOW_KEY. ' +
        'Fetches only that file on your site; contacts no search engine. Run it before the first indexnow_submit_urls.',
      inputSchema: z.object({
        site_url: z.string().min(1).describe('Any absolute URL on the host to check, e.g. "https://example.com/".'),
      }),
    },
    async ({ site_url }) => {
      const sample = parseHttpUrl(site_url);
      if (!sample) return errorResult('Error: site_url must be an absolute http(s) URL.');
      const loc = resolveKeyLocation(cfg, sample);
      if (!loc.ok) return errorResult(`Error: ${loc.error}`);
      if (new URL(loc.keyFileUrl).host.toLowerCase() !== sample.host.toLowerCase()) {
        return errorResult(`Error: INDEXNOW_KEY_LOCATION points at another host (${new URL(loc.keyFileUrl).host}); the key file must be on ${sample.host}.`);
      }
      const check = await client.checkKeyFile(loc.keyFileUrl);
      const result = {
        host: sample.host,
        key_file: check.url.replace(cfg.key, '<INDEXNOW_KEY>'),
        http_status: check.status,
        matches: check.matches,
        message: check.message,
      };
      return check.matches ? jsonResult(result) : jsonError(result);
    },
  );
}
