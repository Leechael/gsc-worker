/** Pre-deploy guard against an unedited wrangler.jsonc template. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPlaceholders, stripJsonc } from '../scripts/wrangler-placeholders.js';

const TEMPLATE = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('the shipped template is rejected, naming every placeholder', () => {
  const paths = findPlaceholders(TEMPLATE).map((p) => p.path).sort();
  assert.deepEqual(paths, [
    '$.kv_namespaces[0].id',
    '$.routes[0].pattern',
    '$.vars.CF_ACCESS_AUD',
    '$.vars.CF_ACCESS_TEAM_DOMAIN',
    '$.vars.MCP_ALLOWED_HOSTS',
  ]);
});

test('a filled-in config passes even though its comments still mention REPLACE_ME', () => {
  const filled = TEMPLATE
    .replaceAll('gsc-mcp.example.com', 'gsc.acme.dev')
    .replace('REPLACE_ME_KV_NAMESPACE_ID', '0f1e2d3c4b5a69788796a5b4c3d2e1f0')
    .replace('https://REPLACE_ME.cloudflareaccess.com', 'https://acme.cloudflareaccess.com')
    .replace('REPLACE_ME_ACCESS_AUD_TAG', 'a'.repeat(64));
  assert.match(filled, /REPLACE_ME/, 'comments keep their instructions');
  assert.deepEqual(findPlaceholders(filled), []);
});

test('hostnames that merely contain example.com are not placeholders', () => {
  assert.deepEqual(findPlaceholders('{"vars": {"MCP_ALLOWED_HOSTS": "myexample.com,example.company.io"}}'), []);
  assert.equal(findPlaceholders('{"vars": {"MCP_ALLOWED_HOSTS": "ok.dev,mcp.example.com"}}').length, 1);
});

test('comment stripping leaves // and /* inside strings alone', () => {
  const text = '{ "a": "https://x/*y*/", // note\n "b": 1, /* gone */ }';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 'https://x/*y*/', b: 1 });
});
