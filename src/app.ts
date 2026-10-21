import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
  getConfig,
  INVALID_CONFIG_MESSAGE,
  validateHttpConfig,
  validateHttpWarnings,
  VERSION,
  type Config,
  type EntryKind,
} from './lib/config.js';
import { buildAuthenticator } from './lib/mcp-auth/index.js';
import { registerGoogleAuthRoutes } from './lib/google-oauth/routes.js';
import { getServices } from './mcp/context.js';
import { buildMcpServer } from './mcp/server.js';

/**
 * Hono app: Host/Origin validation → MCP_AUTH_MODE 鉴权 → /mcp, /auth/google/* → /health.
 * Lazy config resolution so the Worker entry can swap in per-request bindings
 * via setEnvSource() before app.fetch runs.
 */
export function buildApp(entry: Exclude<EntryKind, 'stdio'>): ReturnType<typeof createMcpHonoApp> {
  const config = () => getConfig();
  const startupErrors = () => validateHttpConfig(config(), entry);
  const auth = () => buildAuthenticator(config(), startupErrors());

  const cfg = config();
  if (entry === 'worker') logWorkerDiagnostics(cfg, startupErrors());
  // On Workers MCP_HOST is meaningless and would otherwise select localhost
  // Origin checks; same-host origins are what the /auth/google pages send.
  const allowedOrigins = cfg.allowedOrigins ?? (entry === 'worker' ? cfg.allowedHosts : undefined);
  const app = createMcpHonoApp({
    host: cfg.host,
    ...(cfg.allowedHosts ? { allowedHosts: cfg.allowedHosts } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });

  const handler = createMcpHandler(() => buildMcpServer(), { legacy: 'stateless' });

  app.get('/health', async (c) => {
    const errors = startupErrors();
    const status = await getServices().tokenProvider.status();
    // token availability reflects KNOWN refresh failures (e.g. invalid_grant)
    // without leaking any error detail (plan §6.2, review P2-12).
    return c.json({
      ok: errors.length === 0,
      version: VERSION,
      google_token_configured: status.configured,
      google_token_available: status.configured && status.error === null,
      google_token_source: status.source,
      // Counts only: /health is unauthenticated, so account emails stay out of it.
      google_accounts: {
        total: status.accounts.length,
        available: status.accounts.filter((a) => a.available).length,
      },
      ...(errors.length === 0 ? {} : { error: 'invalid configuration' }),
    });
  });

  registerGoogleAuthRoutes(app, { entry, config, auth, services: getServices });

  app.all('/mcp', async (c) => {
    const gate = auth();
    if (!gate.ok) {
      return c.text(INVALID_CONFIG_MESSAGE, 503);
    }
    const outcome = await gate.authenticate(c.req.raw);
    if (outcome.kind === 'deny') return outcome.response;
    return handler.fetch(c.req.raw, {
      parsedBody: c.var.parsedBody,
      authInfo: outcome.authInfo,
    });
  });

  return app;
}

/**
 * The Worker has no startup phase that can refuse to start, and the Worker
 * entry builds this app once per bindings object, so this is the one place
 * to surface config problems in the logs (wrangler tail). Requests then fail
 * closed with a generic 503 (or 403 from host validation).
 */
function logWorkerDiagnostics(cfg: Config, errors: string[]): void {
  for (const w of validateHttpWarnings(cfg, 'worker')) {
    console.warn(`gsc-mcp-ts: warning: ${w}`);
  }
  if (errors.length > 0) {
    console.error('gsc-mcp-ts: invalid configuration, answering 503 (fail closed):');
    for (const e of errors) console.error(`  - ${e}`);
  }
}
