/**
 * Registration and diagnostics for the optional engines listed in
 * ./registry.ts. server.ts and get_capabilities only call into this file.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../lib/config.js';
import type { ServerServices } from '../mcp/context.js';
import { ENGINES } from './registry.js';
import { tierAllows } from './types.js';

/** Register tools for every engine that is enabled. */
export function registerEngineTools(server: McpServer, svc: ServerServices): void {
  for (const engine of ENGINES) {
    if (engine.enabled(svc.config)) engine.register(server, svc);
  }
}

const TIER_HINT = {
  read: '',
  write: 'needs GSC_SCOPES=full',
  destructive: 'needs GSC_SCOPES=full and GSC_ALLOW_DESTRUCTIVE=true',
} as const;

/** get_capabilities section: which engines are enabled. Never prints secret values. */
export function engineCapabilityLines(config: Config): string[] {
  if (ENGINES.length === 0) return [];
  const lines: string[] = ['', 'OPT-IN ENGINES (tools appear only when configured):'];
  for (const engine of ENGINES) {
    if (!engine.enabled(config)) {
      const hint = engine.enableHint ?? `set the ${engine.enableVar} secret to enable ${engine.id}_* tools`;
      lines.push(`- ${engine.label}: not configured (${hint})`);
      continue;
    }
    lines.push(`- ${engine.label}: enabled (${engine.enableVar} is set)`);
    for (const extra of engine.statusLines(config)) lines.push(`    ${extra}`);
    for (const tool of engine.tools) {
      const gated = tool.tier !== 'read' && !tierAllows(config.scopeTier, tool.tier);
      lines.push(`  - ${tool.name} [${tool.tier}]: ${tool.summary}${gated ? ` (not enabled at the current tier: ${TIER_HINT[tool.tier]})` : ''}`);
    }
  }
  return lines;
}
