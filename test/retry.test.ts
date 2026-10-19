/** GscClient retry/backoff tests (M2 acceptance: 退避单测). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GscClient } from '../src/lib/gsc-client.js';
import { TokenProvider } from '../src/lib/auth.js';

function fakeTokenProvider() {
  return new TokenProvider(
    { clientId: 'id', clientSecret: 'sec', refreshToken: 'ref', scopes: [] },
    // fetchImpl unused: access token is cached after first refresh, so give it
    // a working stub that never gets called in these tests.
    (() => Promise.resolve(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 })))) as typeof fetch,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('429 then success: retries and returns the payload', async () => {
  const calls: number[] = [];
  let n = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push((url as URL).pathname.length);
    n++;
    return n < 3 ? jsonResponse(429, { error: { message: 'quota exceeded' } }) : jsonResponse(200, { ok: true });
  }) as typeof fetch;

  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 4 });
  const out = await client.request<{ ok: boolean }>('/x');
  assert.equal(out.ok, true);
  assert.equal(n, 3);
});

test('500 keeps retrying until maxAttempts, then throws GscApiError', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonResponse(503, { error: { message: 'unavailable' } });
  }) as typeof fetch;

  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 3 });
  await assert.rejects(() => client.request('/x'), (e: unknown) => {
    assert.equal((e as { status?: number }).status, 503);
    return true;
  });
  assert.equal(n, 3);
});

test('4xx (non-retryable) fails immediately without retry', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonResponse(400, { error: { message: 'bad request' } });
  }) as typeof fetch;

  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 4 });
  await assert.rejects(() => client.request('/x'), (e: unknown) => {
    assert.equal((e as { status?: number }).status, 400);
    return true;
  });
  assert.equal(n, 1);
});

test('204 responses resolve without reading a body', async () => {
  const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl });
  const out = await client.request<undefined>('/x', { method: 'DELETE' });
  assert.equal(out, undefined);
});
