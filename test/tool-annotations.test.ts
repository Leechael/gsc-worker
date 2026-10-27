/**
 * MCP tool annotations:
 * - every registered tool (Google and every engine) carries annotations
 * - the hints follow the tool's tier in its tier table
 * - the tier gates in the tool code agree with those tables, so the set of
 *   tools marked destructive is exactly the set gated behind
 *   GSC_ALLOW_DESTRUCTIVE
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { setEnvSource } from '../src/lib/config.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { ENGINES } from '../src/engines/registry.js';
import { GSC_TOOLS } from '../src/tools/tool-tiers.js';
import type { ToolPolicy } from '../src/mcp/tool-annotations.js';

interface RegisteredTool {
  annotations?: ToolAnnotations;
}

function toolsOf(server: unknown): Record<string, RegisteredTool> {
  return (server as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

after(() => setEnvSource(process.env as Record<string, unknown>));

/** Every engine enabled, so all engine tools get registered. */
function allTools(): Record<string, RegisteredTool> {
  setEnvSource({
    BING_API_KEY: 'test-bing-key',
    INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
    YANDEX_OAUTH_TOKEN: 'test-yandex-token',
    SEZNAM_API_KEY: 'test-seznam-key',
  });
  return toolsOf(buildMcpServer());
}

const POLICIES: ToolPolicy[] = [...GSC_TOOLS, ...ENGINES.flatMap((e) => e.tools)];
const policyOf = (name: string) => POLICIES.find((p) => p.name === name);

test('tier tables have no duplicate tool names', () => {
  const names = POLICIES.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test('every registered tool has annotations and a tier-table entry, and vice versa', () => {
  const tools = allTools();
  const names = Object.keys(tools).sort();
  assert.ok(names.length >= 69, `only ${names.length} tools registered`);
  for (const name of names) {
    assert.ok(tools[name]!.annotations, `${name} has no annotations`);
    assert.ok(policyOf(name), `${name} is missing from the tier tables`);
  }
  assert.deepEqual(POLICIES.map((p) => p.name).sort(), names);
});

test('annotations follow the tier', () => {
  for (const [name, tool] of Object.entries(allTools())) {
    const a = tool.annotations!;
    const policy = policyOf(name)!;
    assert.equal(typeof a.openWorldHint, 'boolean', name);
    if (policy.tier === 'read') {
      assert.equal(a.readOnlyHint, true, name);
      assert.equal(a.destructiveHint, undefined, name);
    } else {
      assert.equal(a.readOnlyHint, false, name);
      assert.equal(a.destructiveHint, policy.tier === 'destructive', name);
      assert.equal(typeof a.idempotentHint, 'boolean', name);
    }
  }
});

test('expected destructive tools are marked destructive', () => {
  const tools = allTools();
  const destructive = Object.keys(tools).filter((n) => tools[n]!.annotations?.destructiveHint === true).sort();
  assert.deepEqual(destructive, [
    'add_site',
    'bing_remove_feed',
    'delete_site',
    'delete_sitemap',
    'manage_sitemaps',
    'yandex_delete_sitemap',
  ]);
});

/** Every `...Gate(tier, 'tool_name', 'write' | 'destructive'...)` call in src/. */
function gateCallsInSource(): Map<string, string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(import.meta.dirname, '..', 'src'));
  const gates = new Map<string, string>();
  const re = /(?:tierGateMessage|engineTierGate|seznamTierGate|yandexGate|grantedWriteGate)\(\s*[^,]+,\s*'([a-z_]+)',\s*'(write|destructive)'/g;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) gates.set(m[1]!, m[2]!);
  }
  return gates;
}

test('tier gates in the tool code match the tier tables', () => {
  const gates = gateCallsInSource();
  // Guard against the regex silently matching nothing.
  assert.ok(gates.size >= 10, `found only ${gates.size} gate calls`);
  for (const [name, tier] of gates) {
    assert.equal(policyOf(name)?.tier, tier, `${name} is gated '${tier}' but its table says '${policyOf(name)?.tier}'`);
  }
  // Every non-read tool is gated somewhere, except manage_sitemaps, which
  // reaches the submit_sitemap / delete_sitemap gates through its actions.
  const viaOtherGates: Record<string, string[]> = { manage_sitemaps: ['submit_sitemap', 'delete_sitemap'] };
  for (const p of POLICIES.filter((x) => x.tier !== 'read')) {
    const names = viaOtherGates[p.name] ?? [p.name];
    const tiers = names.map((n) => gates.get(n));
    assert.ok(tiers.every((t) => t !== undefined), `${p.name} has no tier gate`);
    assert.ok(tiers.includes(p.tier), `${p.name} is never gated at its table tier '${p.tier}'`);
  }
});
