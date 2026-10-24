import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../lib/config.js';
import type { ServerServices } from '../mcp/context.js';
import { textResult } from './helpers.js';
import { toolAnnotations } from '../mcp/tool-annotations.js';
import { GSC_TOOLS } from './tool-tiers.js';

/**
 * get_creator_info + reauthenticate (plan §6.3: reauthenticate 返回操作指引，
 * 不在服务器端弹浏览器).
 */
export function registerAuthInfoTools(server: McpServer, svc: ServerServices): void {
  server.registerTool(
    'get_creator_info',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'get_creator_info'),
      title: 'Creator info',
      description: 'Information about the creator of the original mcp-gsc project.',
    },
    async () =>
      textResult(`# About the original project

This server is a TypeScript port of mcp-gsc by Amin Foroutan:
https://github.com/AminForou/mcp-gsc

Amin is an SEO consultant with over a decade of experience, specializing in
technical SEO, Python-driven tools, and data analysis for SEO performance.

- LinkedIn: https://www.linkedin.com/in/ma-foroutan/
- Website: https://aminforoutan.com/
- YouTube: https://www.youtube.com/channel/UCW7tPXg-rWdH4YzLrcAdBIw
- X: https://x.com/aminfseo`),
  );

  server.registerTool(
    'reauthenticate',
    {
      annotations: toolAnnotations(GSC_TOOLS, 'reauthenticate'),
      title: 'Re-authentication guidance',
      description:
        'How to re-authenticate with a different Google account or scope tier. ' +
        'On Workers with KV storage, open /auth/google on the deployment; otherwise run the auth bootstrap on a local machine, then update the deployment secret.',
      inputSchema: z.object({}),
    },
    async () => {
      const tier = svc.config.scopeTier;
      // Re-authorize at the scope the deployment actually needs (review P2-10):
      // readonly covers the read tier; the full webmasters scope covers write
      // and destructive tiers.
      const neededScope = tier === 'read' ? 'readonly' : 'full';
      const ga4Flag = svc.config.ga4Enabled ? ' --ga4' : '';
      const whoMay = authorizeRequirement(svc.config);
      const ga4Note = svc.config.ga4Enabled
        ? `\nThis deployment has GA4_ENABLED=true, so consent must also include analytics.readonly. ` +
          `A Search Console-only token will not run ga4_* tools until you re-consent.`
        : '';
      return textResult(
        `On Cloudflare Workers with the GSC_TOKENS KV binding, re-authorize in a browser:
  open https://<worker-host>/auth/google (check status at /auth/google/status).
Only the deployment's operator can do this: it takes ${whoMay}. Anyone else gets 403,
so if that is not you, ask the operator.
The new token replaces the stored token of the same Google account; signing in as another account adds it
(tools then pick the account per property). Stored accounts take precedence over GOOGLE_REFRESH_TOKEN as the default.
${ga4Note}

Otherwise this server uses credentials from its environment (no browser access here).
To switch Google account or re-authorize at the current tier (${tier}), run locally:

  npm run auth -- --scopes ${neededScope}${ga4Flag} \\
    --client-secrets path/to/client_secrets.json --out gsc-credentials.json

Scope tiers: readonly → read tools only; full → + submit_sitemap (GSC_SCOPES=full); ` +
        `+ add_site/delete_site/delete_sitemap (also GSC_ALLOW_DESTRUCTIVE=true).
To CHANGE tier, update GSC_SCOPES (and GSC_ALLOW_DESTRUCTIVE) in the server
environment along with the new credentials.

Then either point the server at the file (local/Docker):
  export GSC_CREDENTIALS_FILE=$PWD/gsc-credentials.json

…or update the deployment secrets:
  - Docker:  mount the file + -e GSC_CREDENTIALS_FILE=..., or set the three GOOGLE_* env vars
  - Workers: npx wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN

Warnings (plan §6.2):
- OAuth consent screen in "Testing" mode → refresh tokens expire in 7 days. Publish as "In production".
- Re-running the auth script mints a new refresh token; Google silently revokes the oldest beyond 100 per account+client.
- A token unused for 6 months expires.`,
      );
    },
  );
}

/** What a request to /auth/google must carry under the configured MCP_AUTH_MODE (all modes must pass). */
function authorizeRequirement(cfg: Config): string {
  const admins = cfg.googleAuth.admins.length > 0;
  const checks: string[] = [];
  for (const mode of cfg.auth.modes) {
    if (mode === 'cf-access') {
      checks.push(admins ? 'a Cloudflare Access login' : 'a Cloudflare Access user login (service tokens are refused)');
    } else if (mode === 'bearer') {
      checks.push('the MCP_AUTH_TOKEN');
    }
  }
  const required = checks.length > 0 ? checks.join(' and ') : 'the configured MCP_AUTH_MODE checks';
  return admins ? `${required}, with one of those identities listed in GOOGLE_AUTH_ADMINS` : required;
}
