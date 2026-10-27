/** GscClient retry/backoff tests (M2 acceptance: 退避单测). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GscApiError, GscClient, parseRetryAfterMs } from '../src/lib/gsc-client.js';
import { TokenProvider } from '../src/lib/auth.js';

function fakeTokenProvider() {
  return new TokenProvider(
    { clientId: 'id', clientSecret: 'sec', refreshToken: 'ref', scopes: [] },
    // fetchImpl unused: access token is cached after first refresh, so give it
    // a working stub that never gets called in these tests.
    (() => Promise.resolve(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 })))) as typeof fetch,
  );
}

/** Records requested delays instead of waiting. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { delays, sleep };
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

  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 4, sleep });
  const out = await client.request<{ ok: boolean }>('/x');
  assert.equal(out.ok, true);
  assert.equal(n, 3);
  assert.equal(delays.length, 2);
});

test('500 keeps retrying until maxAttempts, then throws GscApiError', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonResponse(503, { error: { message: 'unavailable' } });
  }) as typeof fetch;

  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 3, sleep });
  await assert.rejects(() => client.request('/x'), (e: unknown) => {
    assert.equal((e as { status?: number }).status, 503);
    return true;
  });
  assert.equal(n, 3);
  // No delay after the final failed attempt.
  assert.equal(delays.length, 2);
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

test('204 responses resolve to an empty object', async () => {
  const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl });
  const out = await client.request<unknown>('/x', { method: 'DELETE' });
  assert.deepEqual(out, {});
});

test('200 with an empty body resolves to an empty object', async () => {
  const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch;
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl });
  const out = await client.request<unknown>('/x', { method: 'PUT' });
  assert.deepEqual(out, {});
});

test('200 with a non-JSON body throws a clear error naming endpoint and status', async () => {
  const fetchImpl = (async () =>
    new Response('<html>captive portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl });
  await assert.rejects(() => client.request('/webmasters/v3/sites'), (e: unknown) => {
    assert.ok(e instanceof GscApiError);
    assert.equal(e.status, 200);
    assert.match(e.message, /non-JSON/);
    assert.match(e.message, /GET \/webmasters\/v3\/sites/);
    assert.match(e.message, /text\/html/);
    return true;
  });
});

test('429 with Retry-After (seconds) waits that long, then succeeds', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Retry-After': '3' },
      });
    }
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;
  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, sleep });
  const out = await client.request<{ ok: boolean }>('/x');
  assert.equal(out.ok, true);
  assert.deepEqual(delays, [3000]);
});

test('503 with Retry-After (HTTP-date) is honored', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) {
      const at = new Date(Date.now() + 5000).toUTCString();
      return new Response('{}', { status: 503, headers: { 'Retry-After': at } });
    }
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;
  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, sleep });
  await client.request('/x');
  assert.equal(delays.length, 1);
  // HTTP-dates have 1 s resolution.
  assert.ok(delays[0]! > 3000 && delays[0]! <= 5000, `delay ${delays[0]}`);
});

test('Retry-After above the cap fails fast with an error naming the endpoint', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'Retry-After': '120' },
    });
  }) as typeof fetch;
  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, sleep });
  await assert.rejects(
    () => client.request('/v1/urlInspection/index:inspect', { method: 'POST', body: {} }),
    (e: unknown) => {
      assert.ok(e instanceof GscApiError);
      assert.equal(e.status, 429);
      assert.match(e.message, /POST \/v1\/urlInspection\/index:inspect/);
      assert.match(e.message, /120 s/);
      return true;
    },
  );
  assert.equal(n, 1);
  assert.equal(delays.length, 0);
});

test('network errors retry, then throw with the endpoint and no trailing delay', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const { delays, sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 3, sleep });
  await assert.rejects(() => client.request('/webmasters/v3/sites'), /GET \/webmasters\/v3\/sites failed: fetch failed/);
  assert.equal(n, 3);
  assert.equal(delays.length, 2);
});

test('each attempt is aborted after timeoutMs', async () => {
  const signals: AbortSignal[] = [];
  const fetchImpl = ((_url: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  }) as typeof fetch;
  const { sleep } = recordingSleep();
  const client = new GscClient({ tokenProvider: fakeTokenProvider(), fetchImpl, maxAttempts: 2, timeoutMs: 20, sleep });
  // AbortSignal.timeout timers are unref'd; keep the event loop alive meanwhile.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(() => client.request('/x'), /GET \/x failed: timed out after 20 ms/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});

test('parseRetryAfterMs handles seconds, HTTP-dates and junk', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterMs(null, now), null);
  assert.equal(parseRetryAfterMs('', now), null);
  assert.equal(parseRetryAfterMs('7', now), 7000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:04 GMT', now), 4000);
  assert.equal(parseRetryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
  assert.equal(parseRetryAfterMs('soon', now), null);
  assert.equal(parseRetryAfterMs('-5', now), null);
});
