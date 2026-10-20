/**
 * IndexNow MCP tools (indexnow_*). Registered only when INDEXNOW_KEY is set.
 * indexnow_submit_urls needs the write tier (GSC_SCOPES=full);
 * indexnow_check_key_file is read-only and only fetches the key file on a host
 * the operator allowed (INDEXNOW_HOSTS, or the host of an absolute
 * INDEXNOW_KEY_LOCATION).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerServices } from '../../mcp/context.js';
import { errorResult, jsonError, jsonResult } from '../../tools/helpers.js';
import { engineTierGate, parseHttpUrl, redactSecret, type EngineToolInfo } from '../types.js';
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS,
  IndexNowClient,
  allowedKeyFileHosts,
  planSubmission,
  resolveKeyLocation,
  type IndexNowConfig,
} from './client.js';

const mask = (text: string, key: string) => redactSecret(text, key).split('***').join('<INDEXNOW_KEY>');

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
      if (!plan.ok) return errorResult(`Error: ${redactSecret(plan.error, cfg.key)}`);
      const outcome = await client.submit(plan);
      const result = {
        host: plan.host,
        submitted: plan.urlList.length,
        key_file: mask(plan.keyFileUrl, cfg.key),
        http_status: outcome.status,
        message: redactSecret(outcome.message, cfg.key),
      };
      return outcome.ok ? jsonResult(result) : errorResult(`Error: ${result.message}`);
    },
  );

  server.registerTool(
    'indexnow_check_key_file',
    {
      title: 'IndexNow: check key file',
      description:
        'Check that the IndexNow key file for a site is publicly reachable over https and contains INDEXNOW_KEY. ' +
        'Only hosts the operator allowed (INDEXNOW_HOSTS, or the host of an absolute INDEXNOW_KEY_LOCATION) are contacted; ' +
        'contacts no search engine. Run it before the first indexnow_submit_urls.',
      inputSchema: z.object({
        site_url: z.string().min(1).describe('Any absolute URL on an allowed host, e.g. "https://example.com/".'),
      }),
    },
    async ({ site_url }) => {
      const sample = parseHttpUrl(site_url);
      if (!sample) return errorResult('Error: site_url must be an absolute http(s) URL without credentials.');
      const host = sample.host.toLowerCase();
      const allowed = allowedKeyFileHosts(cfg);
      if (!allowed.has(host)) {
        const list = [...allowed].sort().join(', ');
        return errorResult(
          mask(
            `Error: ${host} is not an allowed IndexNow host, so its key file is not fetched. ` +
              (list ? `Allowed: ${list}. ` : 'No hosts are allowed yet. ') +
              'Add it to INDEXNOW_HOSTS (comma-separated host names) in the server environment.',
            cfg.key,
          ),
        );
      }
      const loc = resolveKeyLocation(cfg, sample);
      if (!loc.ok) return errorResult(`Error: ${mask(loc.error, cfg.key)}`);
      const keyHost = new URL(loc.keyFileUrl).host.toLowerCase();
      if (keyHost !== host) {
        return errorResult(mask(`Error: INDEXNOW_KEY_LOCATION points at another host (${keyHost}); the key file must be on ${host}.`, cfg.key));
      }
      const check = await client.checkKeyFile(loc.keyFileUrl);
      const result = {
        host,
        key_file: mask(check.url, cfg.key),
        http_status: check.status,
        matches: check.matches,
        message: mask(check.message, cfg.key),
      };
      return check.matches ? jsonResult(result) : jsonError(result);
    },
  );
}
