import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from '../lib/config.js';
import { getServices } from './context.js';
import { registerCapabilitiesTools } from '../tools/capabilities.js';
import { registerAuthInfoTools } from '../tools/auth-info.js';
import { registerPropertiesTools } from '../tools/properties.js';
import { registerAnalyticsTools } from '../tools/analytics.js';
import { registerAdvancedAnalyticsTools } from '../tools/analytics-advanced.js';
import { registerInspectionTools } from '../tools/inspection.js';
import { registerSitemapsTools } from '../tools/sitemaps.js';
import { registerEngineTools } from '../engines/index.js';

/**
 * Per-request MCP server factory (plan §3): every HTTP request gets a fresh
 * McpServer; tools/services are shared through getServices().
 *
 * All 21 tools from the Python版 are registered; write/destructive tools gate
 * themselves at runtime via the scope tier (plan §6.1) instead of being
 * conditionally registered, so prompts referencing them get upgrade guidance
 * rather than "tool not found".
 *
 * Opt-in engines (src/engines/) are registered only when their secret is set.
 * Write/destructive engine tools are then tier-gated the same way. GA4 tools
 * are read-only and always registered; they gate on the account's Google grant.
 */
export function buildMcpServer(): McpServer {
  const svc = getServices();
  const server = new McpServer({ name: 'gsc-mcp-ts', version: VERSION });
  registerCapabilitiesTools(server, svc);
  registerAuthInfoTools(server, svc);
  registerPropertiesTools(server, svc);
  registerAnalyticsTools(server, svc);
  registerAdvancedAnalyticsTools(server, svc);
  registerInspectionTools(server, svc);
  registerSitemapsTools(server, svc);
  registerEngineTools(server, svc);
  return server;
}
