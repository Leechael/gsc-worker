/**
 * MCP tool annotations derived from each tool's scope tier, so the hints a
 * client sees and the tier gate that actually guards a tool come from the
 * same table (GSC_TOOLS in src/tools/tool-tiers.ts and each engine's
 * *_TOOLS list).
 *
 * - read: readOnlyHint true.
 * - write: readOnlyHint false, destructiveHint false.
 * - destructive: readOnlyHint false, destructiveHint true. This follows the
 *   TOOL_TIER=destructive gate, so add_site is marked destructive too.
 * - idempotentHint (non-read tools only) is true only when repeating the
 *   call leaves the remote state unchanged and spends no quota.
 * - openWorldHint is false for tools that only reach a fixed search-engine
 *   API for the configured account; it is true for tools that fetch a
 *   caller-supplied host or broadcast to third-party engines (IndexNow).
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';

export type ToolTier = 'read' | 'write' | 'destructive';

export interface ToolPolicy {
  name: string;
  tier: ToolTier;
  /** Repeating the call has no further effect. Ignored for read tools. Default false. */
  idempotent?: boolean;
  /** The tool reaches hosts beyond a fixed search-engine API. Default false. */
  openWorld?: boolean;
}

export function annotationsFor(policy: ToolPolicy): ToolAnnotations {
  const openWorldHint = policy.openWorld ?? false;
  if (policy.tier === 'read') return { readOnlyHint: true, openWorldHint };
  return {
    readOnlyHint: false,
    destructiveHint: policy.tier === 'destructive',
    idempotentHint: policy.idempotent ?? false,
    openWorldHint,
  };
}

/** Annotations for `name` from its policy table; throws if the tool is missing from it. */
export function toolAnnotations(policies: readonly ToolPolicy[], name: string): ToolAnnotations {
  const policy = policies.find((p) => p.name === name);
  if (!policy) throw new Error(`Tool ${name} has no entry in its tier table`);
  return annotationsFor(policy);
}
