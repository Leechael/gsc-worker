/**
 * IndexNow engine: opt-in registration, request shape, host/key-location
 * rules, response mapping, tier gating, and key hygiene. fetch is mocked;
 * nothing calls IndexNow or any site.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { parseConfig, setEnvSource } from '../src/lib/config.js';
import { TokenProvider } from '../src/lib/auth.js';
import { GscClient } from '../src/lib/gsc-client.js';
import type { ServerServices } from '../src/mcp/context.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { registerCapabilitiesTools } from '../src/tools/capabilities.js';
import { indexNowEngine } from '../src/engines/indexnow/index.js';
import { INDEXNOW_TOOLS } from '../src/engines/indexnow/tools.js';
import {
  INDEXNOW_ENDPOINT,
  IndexNowClient,
  KEY_FILE_MAX_BYTES,
  allowedKeyFileHosts,
  isValidIndexNowKey,
  parseHostList,
  planSubmission,
  resolveKeyLocation,
} from '../src/engines/indexnow/client.js';

const KEY = 'fa8c0a469da44e9b8f6a769f291829f5';

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  executor: (args: unknown, ctx: unknown) => Promise<ToolResult>;
}
const toolsOf = (server: McpServer) =>
  (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

afterEach(() => {
  setEnvSource(process.env as Record<string, unknown>);
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function services(env: Record<string, unknown>): ServerServices {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google, (async () => new Response('{}', { status: 500 })) as typeof fetch);
  return { config, tokenProvider, gsc: new GscClient({ tokenProvider }) };
}

function indexNowServer(env: Record<string, unknown>, respond: (call: Call) => Response | Promise<Response> = () => new Response('', { status: 200 })) {
  const svc = services({ INDEXNOW_KEY: KEY, ...env });
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const server = new McpServer({ name: 't', version: '0' });
  indexNowEngine.register(server, svc, fetchImpl);
  const run = (name: string, args: unknown) => toolsOf(server)[name]!.executor(args, {});
  return { calls, run };
}

const FULL = { GSC_SCOPES: 'full' };

// ---------- opt-in registration ----------

test('indexnow tools are not registered when INDEXNOW_KEY is unset or blank', () => {
  for (const env of [{}, { INDEXNOW_KEY: '' }, { INDEXNOW_KEY: '  ' }, { INDEXNOW_KEY_LOCATION: '/k.txt' }]) {
    setEnvSource(env);
    const names = Object.keys(toolsOf(buildMcpServer()));
    assert.ok(names.includes('get_capabilities'));
    assert.deepEqual(names.filter((n) => n.startsWith('indexnow_')), [], JSON.stringify(env));
  }
});

test('indexnow tools are registered when INDEXNOW_KEY is set', () => {
  setEnvSource({ INDEXNOW_KEY: KEY });
  const names = Object.keys(toolsOf(buildMcpServer())).filter((n) => n.startsWith('indexnow_')).sort();
  assert.deepEqual(names, INDEXNOW_TOOLS.map((t) => t.name).sort());
});

test('get_capabilities reports IndexNow status without revealing the key', async () => {
  const text = async (env: Record<string, unknown>) => {
    const svc = services(env);
    const server = new McpServer({ name: 't', version: '0' });
    registerCapabilitiesTools(server, svc);
    return (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
  };
  assert.match(await text({}), /IndexNow: not configured \(set the INDEXNOW_KEY secret/);

  const on = await text({ INDEXNOW_KEY: KEY, INDEXNOW_KEY_LOCATION: `https://example.com/keys/${KEY}.txt` });
  assert.match(on, /IndexNow: enabled \(INDEXNOW_KEY is set\)/);
  assert.match(on, /Key file: INDEXNOW_KEY_LOCATION=https:\/\/example.com\/keys\/<INDEXNOW_KEY>.txt/);
  assert.match(on, /indexnow_submit_urls \[write\].*not enabled at the current tier: needs GSC_SCOPES=full/);
  assert.match(on, /indexnow_check_key_file \[read\]/);
  assert.ok(!on.includes(KEY));

  const full = await text({ INDEXNOW_KEY: KEY, ...FULL });
  assert.doesNotMatch(full, /indexnow_submit_urls \[write\].*not enabled/);

  assert.match(await text({ INDEXNOW_KEY: 'short' }), /INDEXNOW_KEY is not a valid IndexNow key/);
});

// ---------- request shape ----------

test('indexnow_submit_urls POSTs {host,key,urlList} to api.indexnow.org', async () => {
  const { calls, run } = indexNowServer(FULL);
  const res = await run('indexnow_submit_urls', {
    urls: ['https://www.example.com/url1', 'https://www.example.com/folder/url2', 'http://www.example.com/url3', 'https://www.example.com/url1'],
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, INDEXNOW_ENDPOINT);
  assert.equal(c.url, 'https://api.indexnow.org/indexnow');
  assert.equal(c.method, 'POST');
  assert.match(c.headers['Content-Type'] ?? '', /^application\/json; charset=utf-8$/);
  assert.deepEqual(c.body, {
    host: 'www.example.com',
    key: KEY,
    urlList: ['https://www.example.com/url1', 'https://www.example.com/folder/url2', 'http://www.example.com/url3'],
  });
  const out = JSON.parse(res.content[0]!.text);
  assert.equal(out.submitted, 3);
  assert.equal(out.http_status, 200);
  assert.equal(out.key_file, 'https://www.example.com/<INDEXNOW_KEY>.txt');
  assert.ok(!res.content[0]!.text.includes(KEY));
});

test('INDEXNOW_KEY_LOCATION is sent as keyLocation (absolute URL or per-host path)', async () => {
  const abs = indexNowServer({ ...FULL, INDEXNOW_KEY_LOCATION: 'https://www.example.com/myIndexNowKey63638.txt' });
  await abs.run('indexnow_submit_urls', { urls: ['https://www.example.com/a'] });
  assert.equal((abs.calls[0]!.body as Record<string, unknown>).keyLocation, 'https://www.example.com/myIndexNowKey63638.txt');

  const path = indexNowServer({ ...FULL, INDEXNOW_KEY_LOCATION: '/keys/indexnow.txt' });
  await path.run('indexnow_submit_urls', { urls: ['https://blog.example.org/keys/post'] });
  assert.equal((path.calls[0]!.body as Record<string, unknown>).keyLocation, 'https://blog.example.org/keys/indexnow.txt');
});

// ---------- validation ----------

test('submissions are refused locally for mixed hosts, bad URLs, bad keys and out-of-scope key files', () => {
  const mixed = planSubmission(['https://a.example.com/1', 'https://b.example.com/2'], { key: KEY });
  assert.equal(mixed.ok, false);
  assert.match((mixed as { error: string }).error, /share one host; got 2/);

  const bad = planSubmission(['https://a.example.com/1', 'ftp://a.example.com/2', 'relative/path'], { key: KEY });
  assert.match((bad as { error: string }).error, /Not absolute http\(s\) URLs \(or they carry credentials\): ftp:\/\/a.example.com\/2, relative\/path/);

  assert.match((planSubmission(['https://a.example.com/'], { key: 'abc' }) as { error: string }).error, /not a valid IndexNow key/);
  assert.match((planSubmission([' '], { key: KEY }) as { error: string }).error, /No URLs/);

  const otherHost = planSubmission(['https://a.example.com/1'], { key: KEY, keyLocation: 'https://b.example.com/key.txt' });
  assert.match((otherHost as { error: string }).error, /same host/);

  const scoped = planSubmission(['https://a.example.com/catalog/x', 'https://a.example.com/help/y'], { key: KEY, keyLocation: '/catalog/key.txt' });
  assert.match((scoped as { error: string }).error, /only covers URLs under \/catalog\/.*help\/y/);

  const inScope = planSubmission(['https://a.example.com/catalog/x'], { key: KEY, keyLocation: '/catalog/key.txt' });
  assert.equal(inScope.ok, true);

  const tooMany = planSubmission(Array.from({ length: 10_001 }, (_, i) => `https://a.example.com/${i}`), { key: KEY });
  assert.match((tooMany as { error: string }).error, /at most 10000/);
  assert.equal(planSubmission(Array.from({ length: 10_000 }, (_, i) => `https://a.example.com/${i}`), { key: KEY }).ok, true);

  assert.equal(isValidIndexNowKey('I-love-IndexNow-3000'), true);
  assert.equal(isValidIndexNowKey('has space'), false);
  assert.equal(isValidIndexNowKey('x'.repeat(129)), false);
});

test('invalid submissions never reach the network', async () => {
  const { calls, run } = indexNowServer(FULL);
  const res = await run('indexnow_submit_urls', { urls: ['https://a.example.com/1', 'https://b.example.com/2'] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

// ---------- responses ----------

test('IndexNow response codes map to clear results', async () => {
  const cases: [number, boolean, RegExp][] = [
    [200, true, /Submitted/],
    [202, true, /validation of the key file is still pending/],
    [400, false, /invalid \(HTTP 400/],
    [403, false, /rejected the key \(HTTP 403.*indexnow_check_key_file/],
    [422, false, /HTTP 422.*do not belong to the host/],
    [429, false, /rate-limiting.*HTTP 429/],
    [500, false, /IndexNow returned HTTP 500/],
  ];
  for (const [status, ok, pattern] of cases) {
    const { run } = indexNowServer(FULL, () => new Response(status >= 400 ? `bad key ${KEY}` : '', { status }));
    const res = await run('indexnow_submit_urls', { urls: ['https://example.com/a'] });
    assert.equal(res.isError === true, !ok, String(status));
    assert.match(res.content[0]!.text, pattern);
    assert.ok(!res.content[0]!.text.includes(KEY), `key leaked at ${status}`);
  }
});

test('network failures are reported and redacted', async () => {
  const { run } = indexNowServer(FULL, () => {
    throw new TypeError(`connect failed ${KEY}`);
  });
  const res = await run('indexnow_submit_urls', { urls: ['https://example.com/a'] });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /IndexNow request failed: connect failed \*\*\*/);
});

// ---------- tier gating ----------

test('indexnow_submit_urls is gated at the read tier and does not call the network', async () => {
  const { calls, run } = indexNowServer({});
  const res = await run('indexnow_submit_urls', { urls: ['https://example.com/a'] });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /indexnow_submit_urls changes data in IndexNow.*\(read\)/s);
  assert.match(res.content[0]!.text, /GSC_SCOPES=full/);
  assert.equal(calls.length, 0);

  // Destructive tier also allows write tools.
  const d = indexNowServer({ ...FULL, GSC_ALLOW_DESTRUCTIVE: 'true' });
  assert.equal((await d.run('indexnow_submit_urls', { urls: ['https://example.com/a'] })).isError, undefined);
});

// ---------- key file check ----------

test('indexnow_check_key_file fetches only the key file and reports a match without echoing it', async () => {
  const ALLOW = { INDEXNOW_HOSTS: 'www.example.com' };
  const ok = indexNowServer(ALLOW, () => new Response(`\uFEFF${KEY}\n`, { status: 200 }));
  const res = await ok.run('indexnow_check_key_file', { site_url: 'https://www.example.com/some/page' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(ok.calls.map((c) => [c.method, c.url]), [['GET', `https://www.example.com/${KEY}.txt`]]);
  const out = JSON.parse(res.content[0]!.text);
  assert.equal(out.matches, true);
  assert.equal(out.key_file, 'https://www.example.com/<INDEXNOW_KEY>.txt');
  assert.ok(!res.content[0]!.text.includes(KEY));

  const wrong = indexNowServer(ALLOW, () => new Response('something-else', { status: 200 }));
  const w = await wrong.run('indexnow_check_key_file', { site_url: 'https://www.example.com/' });
  assert.equal(w.isError, true);
  assert.match(w.content[0]!.text, /does not contain exactly INDEXNOW_KEY/);
  assert.ok(!w.content[0]!.text.includes('something-else'));

  const missing = indexNowServer({ ...ALLOW, INDEXNOW_KEY_LOCATION: '/keys/k.txt' }, () => new Response('nope', { status: 404 }));
  const m = await missing.run('indexnow_check_key_file', { site_url: 'https://www.example.com/' });
  assert.equal(m.isError, true);
  assert.equal(missing.calls[0]!.url, 'https://www.example.com/keys/k.txt');
  assert.match(m.content[0]!.text, /HTTP 404/);

  const other = indexNowServer({ ...ALLOW, INDEXNOW_KEY_LOCATION: 'https://cdn.example.net/k.txt' });
  const o = await other.run('indexnow_check_key_file', { site_url: 'https://www.example.com/' });
  assert.equal(o.isError, true);
  assert.equal(other.calls.length, 0);
});

// ---------- review hardening ----------

test('indexnow_check_key_file refuses hosts the operator did not allow, without any request', async () => {
  for (const env of [{}, { INDEXNOW_HOSTS: 'example.com' }, { INDEXNOW_KEY_LOCATION: '/k.txt' }]) {
    const s = indexNowServer(env);
    const res = await s.run('indexnow_check_key_file', { site_url: 'https://attacker.example.net/' });
    assert.equal(res.isError, true, JSON.stringify(env));
    assert.match(res.content[0]!.text, /attacker\.example\.net is not an allowed IndexNow host/);
    assert.match(res.content[0]!.text, /INDEXNOW_HOSTS/);
    assert.equal(s.calls.length, 0, JSON.stringify(env));
    assert.ok(!res.content[0]!.text.includes(KEY));
  }
  // The host of an absolute INDEXNOW_KEY_LOCATION is allowed without INDEXNOW_HOSTS.
  const loc = indexNowServer({ INDEXNOW_KEY_LOCATION: 'https://www.example.com/k.txt' }, () => new Response(KEY));
  assert.equal((await loc.run('indexnow_check_key_file', { site_url: 'https://WWW.example.com/x' })).isError, undefined);
  assert.deepEqual(loc.calls.map((c) => c.url), ['https://www.example.com/k.txt']);
});

test('INDEXNOW_HOSTS parsing and the allowed-host set', () => {
  assert.deepEqual(parseHostList(' Example.com, www.example.com  https://blog.example.org/ shop.example.com:8443 '), [
    'example.com',
    'www.example.com',
    'blog.example.org',
    'shop.example.com:8443',
  ]);
  assert.deepEqual(parseHostList(undefined), []);
  assert.deepEqual(parseHostList('https://u:p@x.example.com/'), []);
  assert.deepEqual([...allowedKeyFileHosts({ key: KEY, hosts: ['a.example.com'], keyLocation: 'https://B.example.com/k.txt' })].sort(), [
    'a.example.com',
    'b.example.com',
  ]);
  assert.deepEqual([...allowedKeyFileHosts({ key: KEY, keyLocation: '/k.txt' })], []);
});

test('the key file is always checked over https, even for an http site_url', async () => {
  const s = indexNowServer({ INDEXNOW_HOSTS: 'www.example.com' }, () => new Response(KEY));
  const res = await s.run('indexnow_check_key_file', { site_url: 'http://www.example.com/' });
  assert.equal(res.isError, undefined);
  assert.equal(s.calls[0]!.url, `https://www.example.com/${KEY}.txt`);
  const path = resolveKeyLocation({ key: KEY, keyLocation: '/keys/k.txt' }, new URL('http://a.example.com/x'));
  assert.deepEqual(path, { ok: true, keyFileUrl: 'https://a.example.com/keys/k.txt', keyLocation: 'https://a.example.com/keys/k.txt' });
  const http = new IndexNowClient(KEY, { fetchImpl: (async () => new Response(KEY)) as typeof fetch });
  const out = await http.checkKeyFile('http://a.example.com/k.txt');
  assert.equal(out.matches, false);
  assert.match(out.message, /https/);
});

test('redirects are followed only to https on the same host', async () => {
  const fetchFor = (map: Record<string, () => Response>) => {
    const seen: { url: string; redirect: string | undefined }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      const r = map[String(input)];
      return r ? r() : new Response('nope', { status: 404 });
    }) as typeof fetch;
    return { seen, fetchImpl };
  };
  const redirect = (to: string, status = 301) => () => new Response(null, { status, headers: { location: to } });

  const same = fetchFor({
    'https://a.example.com/k.txt': redirect('/real/k.txt'),
    'https://a.example.com/real/k.txt': () => new Response(KEY),
  });
  const ok = await new IndexNowClient(KEY, { fetchImpl: same.fetchImpl }).checkKeyFile('https://a.example.com/k.txt');
  assert.equal(ok.matches, true);
  assert.deepEqual(same.seen.map((s) => s.redirect), ['manual', 'manual']);

  for (const target of ['https://evil.example.net/k.txt', 'http://a.example.com/k2.txt', `https://evil.example.net/${KEY}.txt`]) {
    const cross = fetchFor({ 'https://a.example.com/k.txt': redirect(target, 302) });
    const out = await new IndexNowClient(KEY, { fetchImpl: cross.fetchImpl }).checkKeyFile('https://a.example.com/k.txt');
    assert.equal(out.matches, false, target);
    assert.equal(out.status, 302);
    assert.match(out.message, /redirects to another host or to http are not followed/);
    assert.equal(cross.seen.length, 1, target);
    assert.ok(!JSON.stringify(out).includes(KEY));
  }

  const loop = fetchFor({ 'https://a.example.com/k.txt': redirect('https://a.example.com/k.txt') });
  const looped = await new IndexNowClient(KEY, { fetchImpl: loop.fetchImpl }).checkKeyFile('https://a.example.com/k.txt');
  assert.match(looped.message, /redirected more than 3 times/);
  assert.equal(loop.seen.length, 4);
});

test('the key file body is capped at 64 KiB', async () => {
  assert.equal(KEY_FILE_MAX_BYTES, 64 * 1024);
  // Declared too large: refused without reading.
  const declared = new IndexNowClient(KEY, {
    fetchImpl: (async () => new Response('x', { headers: { 'content-length': String(KEY_FILE_MAX_BYTES + 1) } })) as typeof fetch,
  });
  assert.match((await declared.checkKeyFile('https://a.example.com/k.txt')).message, /larger than 65536 bytes/);

  // Streamed without a length: reading stops once the cap is passed.
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(16 * 1024).fill(120));
        },
      }),
    );
  const streamed = new IndexNowClient(KEY, { fetchImpl: (async () => endless()) as typeof fetch });
  const out = await streamed.checkKeyFile('https://a.example.com/k.txt');
  assert.equal(out.matches, false);
  assert.match(out.message, /larger than 65536 bytes/);
  assert.ok(pulled <= 6, `pulled ${pulled} chunks`);

  // Exactly at the cap is still read.
  const atCap = new IndexNowClient(KEY, {
    fetchImpl: (async () => new Response(KEY + ' '.repeat(KEY_FILE_MAX_BYTES - KEY.length))) as typeof fetch,
  });
  assert.equal((await atCap.checkKeyFile('https://a.example.com/k.txt')).matches, true);
});

test('the key file check times out', async () => {
  const hang = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      // AbortSignal.timeout() does not keep Node's event loop alive on its own.
      const keepAlive = setTimeout(() => undefined, 5_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
  const out = await new IndexNowClient(KEY, { fetchImpl: hang, timeoutMs: 20 }).checkKeyFile('https://a.example.com/k.txt');
  assert.equal(out.matches, false);
  assert.match(out.message, /timed out after 20 ms/);
});

test('the key never appears in submission errors, key_file fields or capability lines', async () => {
  // Path location that embeds the key, with a URL outside its directory (scope error echoes the path).
  const scoped = planSubmission(['https://a.example.com/other/x'], { key: KEY, keyLocation: `/sub/${KEY}.txt` });
  assert.equal(scoped.ok, false);
  assert.ok(!(scoped as { error: string }).error.includes(KEY));
  assert.match((scoped as { error: string }).error, /\/sub\/\*\*\*\.txt/);

  // Errors echoing caller-supplied URLs or hosts.
  const bad = planSubmission([`ftp://a.example.com/${KEY}`], { key: KEY });
  assert.ok(!(bad as { error: string }).error.includes(KEY));
  const hosts = planSubmission([`https://${KEY}.example.com/`, 'https://b.example.com/'], { key: KEY });
  assert.ok(!(hosts as { error: string }).error.includes(KEY));

  // The same through the tool.
  const s = indexNowServer({ ...FULL, INDEXNOW_KEY_LOCATION: `/sub/${KEY}.txt` });
  const res = await s.run('indexnow_submit_urls', { urls: ['https://a.example.com/other/x'] });
  assert.equal(res.isError, true);
  assert.ok(!res.content[0]!.text.includes(KEY));
  assert.equal(s.calls.length, 0);

  // Every occurrence is masked in key_file (absolute location with the key twice).
  const twice = indexNowServer({ ...FULL, INDEXNOW_KEY_LOCATION: `https://a.example.com/${KEY}/${KEY}.txt` });
  const out = await twice.run('indexnow_submit_urls', { urls: [`https://a.example.com/${KEY}/x`] });
  assert.equal(out.isError, undefined, out.content[0]!.text);
  assert.equal(JSON.parse(out.content[0]!.text).key_file, 'https://a.example.com/<INDEXNOW_KEY>/<INDEXNOW_KEY>.txt');
  const check = indexNowServer({ INDEXNOW_KEY_LOCATION: `https://a.example.com/${KEY}/${KEY}.txt` }, () => new Response('nope', { status: 404 }));
  const c = await check.run('indexnow_check_key_file', { site_url: 'https://a.example.com/' });
  assert.ok(!c.content[0]!.text.includes(KEY));
  assert.match(c.content[0]!.text, /<INDEXNOW_KEY>\/<INDEXNOW_KEY>\.txt/);

  // get_capabilities: encoded forms of an (invalid) key are masked too.
  const odd = 'bad key/with?chars';
  const svc = services({ INDEXNOW_KEY: odd, INDEXNOW_KEY_LOCATION: `https://a.example.com/${encodeURIComponent(odd)}.txt` });
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, svc);
  const text = (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
  assert.ok(!text.includes(encodeURIComponent(odd)));
  assert.ok(!text.includes(odd));
  assert.match(text, /Key file check allowed on: a\.example\.com/);
});

test('URLs with credentials are refused before any request', async () => {
  const plan = planSubmission(['https://user:pass@a.example.com/x'], { key: KEY });
  assert.equal(plan.ok, false);
  const s = indexNowServer({ INDEXNOW_HOSTS: 'a.example.com' });
  const res = await s.run('indexnow_check_key_file', { site_url: 'https://user:pass@a.example.com/' });
  assert.equal(res.isError, true);
  assert.equal(s.calls.length, 0);
});
