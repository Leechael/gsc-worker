/** Auth headers used by scripts/smoke.ts and scripts/export.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpAuthHeaders } from '../scripts/mcp-auth-headers.js';

test('no credentials → no headers', () => {
  assert.deepEqual(mcpAuthHeaders({}), {});
});

test('MCP_AUTH_TOKEN → Authorization: Bearer', () => {
  assert.deepEqual(mcpAuthHeaders({ MCP_AUTH_TOKEN: 't' }), { Authorization: 'Bearer t' });
});

test('MCP_BEARER_HEADER sends the raw token in that header', () => {
  assert.deepEqual(mcpAuthHeaders({ MCP_AUTH_TOKEN: 't', MCP_BEARER_HEADER: 'X-API-Key' }), { 'x-api-key': 't' });
});

test('Cloudflare Access service token headers, alone or with a bearer token', () => {
  assert.deepEqual(mcpAuthHeaders({ CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 's' }), {
    'CF-Access-Client-Id': 'id.access',
    'CF-Access-Client-Secret': 's',
  });
  assert.deepEqual(mcpAuthHeaders({ CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 's', MCP_AUTH_TOKEN: 't' }), {
    'CF-Access-Client-Id': 'id',
    'CF-Access-Client-Secret': 's',
    Authorization: 'Bearer t',
  });
});

test('half a service token is an error', () => {
  assert.throws(() => mcpAuthHeaders({ CF_ACCESS_CLIENT_ID: 'id' }), /both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  assert.throws(() => mcpAuthHeaders({ CF_ACCESS_CLIENT_SECRET: 's' }));
});

test('an empty MCP_BEARER_HEADER means the default Authorization header, as on the server', () => {
  assert.deepEqual(mcpAuthHeaders({ MCP_AUTH_TOKEN: 't', MCP_BEARER_HEADER: '' }), { Authorization: 'Bearer t' });
});

test('MCP_BEARER_HEADER may not reuse a header the scripts already send', () => {
  for (const name of ['CF-Access-Client-Id', 'cf-access-client-secret', 'Accept', 'content-type']) {
    assert.throws(
      () => mcpAuthHeaders({ MCP_AUTH_TOKEN: 't', MCP_BEARER_HEADER: name, CF_ACCESS_CLIENT_ID: 'i', CF_ACCESS_CLIENT_SECRET: 's' }),
      /collides/,
      name,
    );
  }
});
