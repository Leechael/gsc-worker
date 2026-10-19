import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { getConfig, validateHttpConfig, VERSION, type EntryKind } from './lib/config.js';
import { buildAuthenticator } from './lib/mcp-auth/index.js';
import { getServices } from './mcp/context.js';
import { buildMcpServer } from './mcp/server.js';

/**
 * Hono app: Host/Origin validation → MCP_AUTH_MODE 鉴权 → /mcp → /health.
 * Lazy config resolution so the Worker entry can swap in per-request bindings
 * via setEnvSource() before app.fetch runs.
 */
export function buildApp(entry: Exclude<EntryKind, 'stdio'>): ReturnType<typeof createMcpHonoApp> {
  const config = () => getConfig();
  const startupErrors = () => validateHttpConfig(config(), entry);
  const auth = () => buildAuthenticator(config(), startupErrors());

  const cfg = config();
  const app = createMcpHonoApp({
    host: cfg.host,
    ...(cfg.allowedHosts ? { allowedHosts: cfg.allowedHosts } : {}),
    ...(cfg.allowedOrigins ? { allowedOrigins: cfg.allowedOrigins } : {}),
  });

  const handler = createMcpHandler(() => buildMcpServer(), { legacy: 'stateless' });

  app.get('/health', (c) => {
    const errors = startupErrors();
    const svc = getServices();
    // token availability reflects KNOWN refresh failures (e.g. invalid_grant)
    // without leaking any error detail (plan §6.2, review P2-12).
    const available = svc.tokenProvider.configured && svc.tokenProvider.lastErrorMessage === null;
    return c.json({
      ok: errors.length === 0,
      version: VERSION,
      google_token_configured: svc.tokenProvider.configured,
      google_token_available: available,
      ...(errors.length === 0 ? {} : { error: 'invalid configuration' }),
    });
  });

  app.all('/mcp', async (c) => {
    const gate = auth();
    if (!gate.ok) {
      return c.text('Service unavailable: invalid MCP auth configuration.', 503);
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
