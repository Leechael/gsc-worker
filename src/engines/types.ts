/**
 * Shared plumbing for opt-in engines in src/engines/<id>/ (Bing, IndexNow,
 * Yandex, Seznam, and Google Analytics 4).
 *
 * Each engine is opt-in: its tools are registered only when enabled() is true
 * (a secret; GA4 is always on and gated by the Google grant). Write and destructive tools reuse the
 * scope tier from GSC_SCOPES / GSC_ALLOW_DESTRUCTIVE, so one switch governs
 * every engine. GA4 itself is read-only.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config, ScopeTier } from '../lib/config.js';
import type { ServerServices } from '../mcp/context.js';
import { tierGateMessage } from '../tools/helpers.js';
import type { ToolPolicy, ToolTier } from '../mcp/tool-annotations.js';

export type EngineTier = ToolTier;

/** Tool table entry; also the source of the tool's MCP annotations. */
export interface EngineToolInfo extends ToolPolicy {
  summary: string;
}

export interface EngineModule {
  /** Short id, also the tool-name prefix (bing_*, indexnow_*). */
  id: string;
  /** Human-readable name for diagnostics. */
  label: string;
  /** The secret that enables the engine (named in diagnostics, never its value). Absent when always on. */
  enableVar?: string;
  /** True when the engine's secret is configured. */
  enabled(config: Config): boolean;
  /** Extra non-secret status lines for get_capabilities (e.g. config problems). */
  statusLines(config: Config): string[];
  /** Tools the engine registers, with the tier each needs. */
  tools: readonly EngineToolInfo[];
  /** Register the engine's tools. fetchImpl is injectable for tests. */
  register(server: McpServer, svc: ServerServices, fetchImpl?: typeof fetch): void;
}

const TIER_ORDER: ScopeTier[] = ['read', 'write', 'destructive'];

export function tierAllows(current: ScopeTier, required: EngineTier): boolean {
  return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(required);
}

/**
 * Tier gate for engine tools. Uses the same tier decision as
 * tierGateMessage() but explains the switch without the Google
 * re-authorization steps, which do not apply to other engines' keys.
 * Returns null when the tool may proceed.
 */
export function engineTierGate(
  tier: ScopeTier,
  tool: string,
  required: 'write' | 'destructive',
  engineLabel: string,
): string | null {
  if (tierGateMessage(tier, tool, required) === null) return null;
  const googleNote =
    '  Note: GSC_SCOPES=full also switches the Google grant to the full "webmasters" scope; ' +
    're-authorize Google (/auth/google on Workers, or npm run auth -- --scopes full) or Google write tools will fail.';
  if (required === 'destructive') {
    return (
      `Safety: ${tool} removes data from ${engineLabel} and is disabled at the current scope tier (${tier}).\n` +
      'To enable it, set GSC_SCOPES=full and GSC_ALLOW_DESTRUCTIVE=true in the server environment and restart (or redeploy).\n' +
      googleNote
    );
  }
  return (
    `Safety: ${tool} changes data in ${engineLabel} and is disabled at the current scope tier (${tier}).\n` +
    'To enable it, set GSC_SCOPES=full in the server environment and restart (or redeploy).\n' +
    googleNote
  );
}

/** Remove a secret (and its URL-encoded form) from text before it reaches a tool result. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  let out = text.split(secret).join('***');
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join('***');
  return out;
}

/**
 * Parse an absolute http(s) URL; null when it is not one, or when it carries
 * credentials (user:password@host), which must never be forwarded to a search
 * engine.
 */
export function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.username === '' && u.password === '' ? u : null;
  } catch {
    return null;
  }
}
