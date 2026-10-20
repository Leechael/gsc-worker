/**
 * Bing Webmaster Tools engine: opt-in registration, request shape, response
 * normalization, tier gating, error mapping, and key hygiene. fetch is mocked;
 * nothing calls Bing.
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
import { bingEngine } from '../src/engines/bing/index.js';
import { BING_TOOLS } from '../src/engines/bing/tools.js';
import { BingApiError, BingClient, decodeCrawlIssues, parseBingDate } from '../src/engines/bing/client.js';

const KEY = 'bingkey0123456789abcdef0123456789';

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
  url: URL;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function services(env: Record<string, unknown>): ServerServices {
  setEnvSource(env);
  const config = parseConfig();
  const tokenProvider = new TokenProvider(config.google, (async () => new Response('{}', { status: 500 })) as typeof fetch);
  return { config, tokenProvider, gsc: new GscClient({ tokenProvider }) };
}

function bingServer(env: Record<string, unknown>, respond: (call: Call) => Response | Promise<Response>) {
  const svc = services({ BING_API_KEY: KEY, ...env });
  const { calls, fetchImpl } = mockFetch(respond);
  const server = new McpServer({ name: 't', version: '0' });
  bingEngine.register(server, svc, fetchImpl);
  const run = (name: string, args: unknown) => toolsOf(server)[name]!.executor(args, {});
  return { calls, run, svc };
}

// ---------- opt-in registration ----------

test('bing tools are not registered when BING_API_KEY is unset', () => {
  setEnvSource({});
  const names = Object.keys(toolsOf(buildMcpServer()));
  assert.ok(names.includes('get_capabilities'));
  assert.deepEqual(names.filter((n) => n.startsWith('bing_')), []);
});

test('bing tools are registered when BING_API_KEY is set (blank values do not count)', () => {
  setEnvSource({ BING_API_KEY: '   ' });
  assert.equal(Object.keys(toolsOf(buildMcpServer())).some((n) => n.startsWith('bing_')), false);

  setEnvSource({ BING_API_KEY: KEY });
  const names = Object.keys(toolsOf(buildMcpServer())).filter((n) => n.startsWith('bing_')).sort();
  assert.deepEqual(names, BING_TOOLS.map((t) => t.name).sort());
});

test('get_capabilities reports Bing status and tiers without revealing the key', async () => {
  for (const [env, expect] of [
    [{}, /Bing Webmaster Tools: not configured \(set the BING_API_KEY secret/],
    [{ BING_API_KEY: KEY }, /Bing Webmaster Tools: enabled \(BING_API_KEY is set\)/],
  ] as const) {
    const svc = services(env);
    const server = new McpServer({ name: 't', version: '0' });
    registerCapabilitiesTools(server, svc);
    const text = (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
    assert.match(text, expect);
    assert.ok(!text.includes(KEY), 'key must not appear');
    if ('BING_API_KEY' in env) {
      assert.match(text, /bing_submit_urls \[write\].*not enabled at the current tier: needs GSC_SCOPES=full/);
      assert.match(text, /bing_remove_feed \[destructive\].*GSC_ALLOW_DESTRUCTIVE=true/);
      assert.match(text, /bing_get_query_stats \[read\]/);
    }
  }
  const svc = services({ BING_API_KEY: KEY, GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' });
  const server = new McpServer({ name: 't', version: '0' });
  registerCapabilitiesTools(server, svc);
  const text = (await toolsOf(server).get_capabilities!.executor({}, {})).content[0]!.text;
  assert.doesNotMatch(text, /bing_\w+ \[\w+\].*not enabled at the current tier/);
});

// ---------- request shape ----------

test('GET methods use the JSON endpoint, siteUrl and apikey query parameters', async () => {
  const { calls, run } = bingServer({}, () => json({ d: [] }));
  await run('bing_get_query_stats', { site_url: 'https://example.com/' });
  await run('bing_get_url_info', { site_url: 'https://example.com/', url: 'https://example.com/a?b=1' });
  await run('bing_get_link_counts', { site_url: 'https://example.com/', page: 2 });
  await run('bing_list_sites', {});

  const [q, info, links, sites] = calls;
  assert.equal(q!.method, 'GET');
  assert.equal(q!.url.origin + q!.url.pathname, 'https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats');
  assert.equal(q!.url.searchParams.get('siteUrl'), 'https://example.com/');
  assert.equal(q!.url.searchParams.get('apikey'), KEY);
  assert.equal(q!.body, undefined);
  assert.equal(info!.url.pathname.endsWith('/GetUrlInfo'), true);
  assert.equal(info!.url.searchParams.get('url'), 'https://example.com/a?b=1');
  assert.equal(links!.url.searchParams.get('page'), '2');
  assert.equal(sites!.url.pathname.endsWith('/GetUserSites'), true);
  assert.equal(sites!.url.searchParams.has('siteUrl'), false);
});

test('submit tools POST the documented JSON bodies', async () => {
  const { calls, run } = bingServer({ GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' }, () => json({ d: null }));
  const one = await run('bing_submit_urls', { site_url: 'https://example.com/', urls: ['https://example.com/a'] });
  assert.equal(one.isError, undefined);
  await run('bing_submit_urls', {
    site_url: 'https://example.com/',
    urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/a'],
  });
  await run('bing_submit_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/sitemap.xml' });
  await run('bing_remove_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/sitemap.xml' });

  assert.deepEqual(
    calls.map((c) => [c.method, c.url.pathname.split('/').pop(), c.url.searchParams.get('apikey'), c.body]),
    [
      ['POST', 'SubmitUrl', KEY, { siteUrl: 'https://example.com/', url: 'https://example.com/a' }],
      ['POST', 'SubmitUrlBatch', KEY, { siteUrl: 'https://example.com/', urlList: ['https://example.com/a', 'https://example.com/b'] }],
      ['POST', 'SubmitFeed', KEY, { siteUrl: 'https://example.com/', feedUrl: 'https://example.com/sitemap.xml' }],
      ['POST', 'RemoveFeed', KEY, { siteUrl: 'https://example.com/', feedUrl: 'https://example.com/sitemap.xml' }],
    ],
  );
  assert.match(calls[0]!.headers['Content-Type'] ?? '', /application\/json/);
});

test('bing_submit_urls rejects non-http URLs before calling Bing', async () => {
  const { calls, run } = bingServer({ GSC_SCOPES: 'full' }, () => json({ d: null }));
  const res = await run('bing_submit_urls', { site_url: 'https://example.com/', urls: ['ftp://example.com/x', 'not a url'] });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

// ---------- tier gating ----------

test('write and destructive tools are tier-gated and never call Bing when gated', async () => {
  const read = bingServer({}, () => json({ d: null }));
  for (const [tool, args] of [
    ['bing_submit_urls', { site_url: 'https://example.com/', urls: ['https://example.com/a'] }],
    ['bing_submit_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/s.xml' }],
    ['bing_remove_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/s.xml' }],
  ] as const) {
    const res = await read.run(tool, args);
    assert.equal(res.isError, true, tool);
    assert.match(res.content[0]!.text, /GSC_SCOPES=full/);
  }
  assert.equal(read.calls.length, 0);

  const write = bingServer({ GSC_SCOPES: 'full' }, () => json({ d: null }));
  assert.equal((await write.run('bing_submit_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/s.xml' })).isError, undefined);
  const removed = await write.run('bing_remove_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/s.xml' });
  assert.equal(removed.isError, true);
  assert.match(removed.content[0]!.text, /GSC_ALLOW_DESTRUCTIVE=true/);
  assert.equal(write.calls.length, 1);

  // Read tools run at the read tier.
  const ok = await read.run('bing_get_feeds', { site_url: 'https://example.com/' });
  assert.equal(ok.isError, undefined);
});

// ---------- normalization ----------

test('parseBingDate handles WCF dates, offsets, ISO strings and DateTime.MinValue', () => {
  assert.deepEqual(parseBingDate('/Date(1316156400000-0700)/'), { iso: '2011-09-16T07:00:00.000Z', date: '2011-09-16' });
  assert.deepEqual(parseBingDate('/Date(1316156400000)/'), { iso: '2011-09-16T07:00:00.000Z', date: '2011-09-16' });
  assert.equal(parseBingDate('/Date(1316217600000+0900)/')!.date, '2011-09-17');
  assert.equal(parseBingDate('2026-10-01T00:00:00Z')!.date, '2026-10-01');
  assert.equal(parseBingDate('/Date(-62135596800000)/'), null);
  assert.equal(parseBingDate('garbage'), null);
  assert.equal(parseBingDate(undefined), null);
});

test('decodeCrawlIssues expands the CrawlIssues flags', () => {
  assert.deepEqual(decodeCrawlIssues(32), ['ContainsMalware']);
  assert.deepEqual(decodeCrawlIssues(4 | 16 | 256), ['Code4xx', 'BlockedByRobotsTxt', 'TimeOutErrors']);
  assert.deepEqual(decodeCrawlIssues(0), []);
  assert.deepEqual(decodeCrawlIssues(1024), ['Unknown(1024)']);
  assert.deepEqual(decodeCrawlIssues('Code4xx, DnsErrors'), ['Code4xx', 'DnsErrors']);
});

const QUERY_ROWS = {
  d: [
    { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', Query: 'alpha', Date: '/Date(1759215600000-0700)/', Clicks: 10, Impressions: 100, AvgClickPosition: 20, AvgImpressionPosition: 30 },
    { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', Query: 'alpha', Date: '/Date(1759820400000-0700)/', Clicks: 30, Impressions: 300, AvgClickPosition: 10, AvgImpressionPosition: 50 },
    { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', Query: 'beta', Date: '/Date(1759820400000-0700)/', Clicks: 5, Impressions: 1000, AvgClickPosition: 40, AvgImpressionPosition: 60 },
  ],
};

test('bing_get_query_stats aggregates per query with weighted positions and ISO dates', async () => {
  const { run } = bingServer({}, () => json(QUERY_ROWS));
  const out = JSON.parse((await run('bing_get_query_stats', { site_url: 'https://example.com/' })).content[0]!.text);
  assert.equal(out.source, 'GetQueryStats');
  assert.deepEqual(out.data_range, { first: '2025-09-30', last: '2025-10-07' });
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[0], {
    query: 'alpha',
    clicks: 40,
    impressions: 400,
    ctr: 0.1,
    avg_impression_position: 45,
    avg_click_position: 12.5,
    first_date: '2025-09-30',
    last_date: '2025-10-07',
    periods: 2,
  });
  assert.ok(out.notes.some((n: string) => /no date range/.test(n)));
  assert.ok(out.notes.some((n: string) => /scaled by 10/.test(n)));

  const byImpr = JSON.parse((await run('bing_get_query_stats', { site_url: 'https://example.com/', sort_by: 'impressions', row_limit: 1 })).content[0]!.text);
  assert.equal(byImpr.rows.length, 1);
  assert.equal(byImpr.rows[0].query, 'beta');
  assert.equal(byImpr.total_rows, 2);

  const raw = JSON.parse((await run('bing_get_query_stats', { site_url: 'https://example.com/', aggregate: false, start_date: '2025-10-01', end_date: null })).content[0]!.text);
  assert.equal(raw.rows.length, 2);
  assert.ok(raw.rows.every((r: { date: string }) => r.date === '2025-10-07'));
});

test('bing_get_page_stats exposes the Query field as page', async () => {
  const { run } = bingServer({}, () => json({ d: [{ Query: 'https://example.com/p', Date: '/Date(1759820400000-0700)/', Clicks: 1, Impressions: 2 }] }));
  const out = JSON.parse((await run('bing_get_page_stats', { site_url: 'https://example.com/' })).content[0]!.text);
  assert.equal(out.rows[0].page, 'https://example.com/p');
  assert.equal(out.rows[0].query, undefined);
});

test('traffic, crawl, feeds, url info, quota and crawl issues are normalized', async () => {
  const responses: Record<string, unknown> = {
    GetRankAndTrafficStats: { d: [
      { Date: '/Date(1759906800000-0700)/', Clicks: 3, Impressions: 30 },
      { Date: '/Date(1759820400000-0700)/', Clicks: 1, Impressions: 10 },
    ] },
    GetCrawlStats: { d: [{ Date: '/Date(1316156400000-0700)/', CrawledPages: 5, InIndex: 1000, Code2xx: 9998, Code4xx: 1 }] },
    GetFeeds: { d: [{ Compressed: false, FileSize: 1024, LastCrawled: '/Date(1315781995040-0700)/', Status: 'Success', Submitted: '/Date(1316213995040-0700)/', Type: 'Sitemap', Url: 'http://example.com/sitemap.xml', UrlCount: 1023 }] },
    GetUrlInfo: { d: { AnchorCount: 50, DiscoveryDate: '/Date(1315349995266-0700)/', DocumentSize: 0, HttpStatus: 200, IsPage: true, LastCrawledDate: '/Date(1316213995266-0700)/', TotalChildUrlCount: 100, Url: 'http://example.com/' } },
    GetUrlSubmissionQuota: { d: { DailyQuota: 973, MonthlyQuota: 10973 } },
    GetCrawlIssues: { d: [
      { HttpCode: 404, Issues: 4, Url: 'http://example.com/a', InLinks: 1 },
      { HttpCode: 200, Issues: 32, Url: 'http://example.com/b', InLinks: 10 },
    ] },
    GetLinkCounts: { d: { Links: [{ Count: 14, Url: 'http://example.com/page1.html' }], TotalPages: 3 } },
    GetUserSites: { d: [{ AuthenticationCode: 'X', DnsVerificationCode: 'y', IsVerified: true, Url: 'http://example.com' }] },
  };
  const { run } = bingServer({}, (c) => json(responses[c.url.pathname.split('/').pop()!]));
  const site = { site_url: 'http://example.com' };
  const parse = async (tool: string, args: unknown) => JSON.parse((await run(tool, args)).content[0]!.text);

  const traffic = await parse('bing_get_traffic_stats', site);
  assert.deepEqual(traffic.rows.map((r: { date: string }) => r.date), ['2025-10-07', '2025-10-08']);
  assert.deepEqual(traffic.totals, { clicks: 4, impressions: 40, ctr: 0.1 });

  const crawl = await parse('bing_get_crawl_stats', site);
  assert.deepEqual(crawl.rows[0], {
    date: '2011-09-16', crawled_pages: 5, crawl_errors: 0, in_index: 1000, in_links: 0, blocked_by_robots_txt: 0,
    contains_malware: 0, code_2xx: 9998, code_301: 0, code_302: 0, code_4xx: 1, code_5xx: 0, all_other_codes: 0,
  });

  const feeds = await parse('bing_get_feeds', site);
  assert.deepEqual(feeds.feeds[0], {
    url: 'http://example.com/sitemap.xml', type: 'Sitemap', status: 'Success', submitted: '2011-09-16T22:59:55.040Z',
    last_crawled: '2011-09-11T22:59:55.040Z', url_count: 1023, file_size: 1024, compressed: false,
  });

  const info = await parse('bing_get_url_info', { ...site, url: 'http://example.com/' });
  assert.equal(info.http_status, 200);
  assert.equal(info.discovery_date, '2011-09-06T22:59:55.266Z');
  assert.match(info.note, /no URL inspection API/);

  assert.deepEqual(await parse('bing_get_url_submission_quota', site), { site_url: 'http://example.com', daily_quota: 973, monthly_quota: 10973 });

  const issues = await parse('bing_get_crawl_issues', site);
  assert.deepEqual(issues.issue_counts, { ContainsMalware: 1, Code4xx: 1 });
  assert.equal(issues.rows[0].url, 'http://example.com/b');
  const only4xx = await parse('bing_get_crawl_issues', { ...site, issue: 'code4xx' });
  assert.deepEqual(only4xx.rows.map((r: { url: string }) => r.url), ['http://example.com/a']);

  const links = await parse('bing_get_link_counts', site);
  assert.deepEqual(links, { site_url: 'http://example.com', page: 0, total_pages: 3, has_more: true, links: [{ url: 'http://example.com/page1.html', count: 14 }] });

  const sites = await parse('bing_list_sites', {});
  assert.deepEqual(sites, { count: 1, sites: [{ site_url: 'http://example.com', is_verified: true }] });
});

// ---------- errors and throttling ----------

test('Bing faults map to clear messages and never include the API key', async () => {
  const cases: [Response, RegExp, string][] = [
    [json({ ErrorCode: 3, Message: `Invalid API key ${KEY}` }, 400), /not authorized \(InvalidApiKey: Invalid API key \*\*\*\).*BING_API_KEY/, 'auth'],
    [json({ ErrorCode: 4, Message: 'Too many requests' }, 400), /throttled \(ThrottleUser/, 'throttled'],
    [new Response('Too Many Requests', { status: 429 }), /throttled/, 'throttled'],
    [new Response('ERROR!!! ThrottleIP', { status: 200 }), /ThrottleIP.*Cloudflare.*Node or stdio/, 'throttled-ip'],
    [new Response('ERROR!!! ThrottleIP', { status: 403 }), /ThrottleIP/, 'throttled-ip'],
    [json({ ErrorCode: 11, Message: 'Site not found' }, 400), /not found.*bing_list_sites/, 'not-found'],
    [json({ ErrorCode: 7, Message: 'Invalid url' }, 400), /rejected the request \(InvalidUrl/, 'invalid'],
    [new Response('<html>oops</html>', { status: 500 }), /failed \(HTTP 500/, 'api'],
  ];
  for (const [response, pattern, kind] of cases) {
    const { fetchImpl } = mockFetch(() => response.clone());
    const client = new BingClient({ apiKey: KEY, fetchImpl });
    await assert.rejects(client.get('GetQueryStats', { siteUrl: 'https://example.com/' }), (e: unknown) => {
      assert.ok(e instanceof BingApiError);
      assert.equal(e.kind, kind);
      assert.match(e.message, pattern);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  }

  const { run } = bingServer({}, () => json({ ErrorCode: 5, Message: 'host throttled' }, 400));
  const res = await run('bing_get_crawl_stats', { site_url: 'https://example.com/' });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /^Error: Bing GetCrawlStats was throttled \(ThrottleHost/);
});

test('network errors are redacted', async () => {
  const fetchImpl = (async (input: unknown) => {
    throw new TypeError(`fetch failed for ${String(input)}`);
  }) as typeof fetch;
  const client = new BingClient({ apiKey: KEY, fetchImpl });
  await assert.rejects(client.get('GetUserSites'), (e: unknown) => {
    assert.ok(e instanceof BingApiError);
    assert.equal(e.kind, 'network');
    assert.match(e.message, /apikey=\*\*\*/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('responses without the d wrapper are passed through; non-JSON 200 is an error', async () => {
  const plain = new BingClient({ apiKey: KEY, fetchImpl: mockFetch(() => json([{ Url: 'x' }])).fetchImpl });
  assert.deepEqual(await plain.get('GetUserSites'), [{ Url: 'x' }]);
  const html = new BingClient({ apiKey: KEY, fetchImpl: mockFetch(() => new Response('<html/>')).fetchImpl });
  await assert.rejects(html.get('GetUserSites'), /non-JSON/);
});

// ---------- review hardening ----------

/** A 200 response whose body stream fails while it is read. */
function brokenBody(status = 200): Response {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new TypeError('stream reset'));
    },
  });
  return new Response(body, { status });
}

test('a 2xx response whose body cannot be read is an error, not an empty success', async () => {
  const client = new BingClient({ apiKey: KEY, fetchImpl: mockFetch(() => brokenBody()).fetchImpl });
  await assert.rejects(client.post('SubmitUrl', { siteUrl: 'https://example.com/', url: 'https://example.com/a' }), (e: unknown) => {
    assert.ok(e instanceof BingApiError);
    assert.equal(e.kind, 'network');
    assert.equal(e.status, 200);
    assert.match(e.message, /could not be read/);
    return true;
  });
  const { run } = bingServer({ GSC_SCOPES: 'full' }, () => brokenBody());
  const res = await run('bing_submit_urls', { site_url: 'https://example.com/', urls: ['https://example.com/a'] });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0]!.text, /"submitted"/);
});

test('a failed body read on an error status still maps the status', async () => {
  const client = new BingClient({ apiKey: KEY, fetchImpl: mockFetch(() => brokenBody(404)).fetchImpl });
  await assert.rejects(client.get('GetUrlInfo'), (e: unknown) => e instanceof BingApiError && e.kind === 'not-found');
});

test('form-encoded keys are redacted from errors', async () => {
  const odd = 'key with space~tilde';
  const fetchImpl = (async (input: unknown) => {
    throw new TypeError(`fetch failed for ${String(input)}`);
  }) as typeof fetch;
  const client = new BingClient({ apiKey: odd, fetchImpl });
  await assert.rejects(client.get('GetUserSites'), (e: unknown) => {
    assert.ok(e instanceof BingApiError);
    const formEncoded = new URLSearchParams({ k: odd }).toString().slice(2);
    assert.ok(!e.message.includes(formEncoded), e.message);
    assert.ok(!e.message.includes(odd));
    assert.match(e.message, /apikey=\*\*\*/);
    return true;
  });
});

test('date filters reject impossible calendar dates and reversed ranges', async () => {
  const { run, calls } = bingServer({}, () => json(QUERY_ROWS));
  const server = new McpServer({ name: 't', version: '0' });
  bingEngine.register(server, services({ BING_API_KEY: KEY }), mockFetch(() => json([])).fetchImpl);
  for (const tool of ['bing_get_query_stats', 'bing_get_page_stats', 'bing_get_traffic_stats', 'bing_get_crawl_stats']) {
    const schema = (toolsOf(server)[tool] as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
    assert.equal(schema.safeParse({ site_url: 'https://example.com/', start_date: '2025-02-30' }).success, false, tool);
    assert.equal(schema.safeParse({ site_url: 'https://example.com/', end_date: '2025-13-01' }).success, false, tool);
    assert.equal(schema.safeParse({ site_url: 'https://example.com/', start_date: '2024-02-29' }).success, true, tool);
    const res = await run(tool, { site_url: 'https://example.com/', start_date: '2025-10-07', end_date: '2025-10-01' });
    assert.equal(res.isError, true, tool);
    assert.match(res.content[0]!.text, /start_date \(2025-10-07\) is after end_date \(2025-10-01\)/);
  }
  assert.equal(calls.length, 0);
});

test('data_range describes the returned rows and source_window the whole Bing window', async () => {
  const { run } = bingServer({}, () => json(QUERY_ROWS));
  const out = JSON.parse((await run('bing_get_query_stats', { site_url: 'https://example.com/', start_date: '2025-10-01' })).content[0]!.text);
  assert.deepEqual(out.data_range, { first: '2025-10-07', last: '2025-10-07' });
  assert.deepEqual(out.source_window, { first: '2025-09-30', last: '2025-10-07' });
  const traffic = bingServer({}, () =>
    json({ d: [
      { Date: '/Date(1759215600000-0700)/', Clicks: 1, Impressions: 2 },
      { Date: '/Date(1759820400000-0700)/', Clicks: 3, Impressions: 4 },
    ] }),
  );
  const t = JSON.parse((await traffic.run('bing_get_traffic_stats', { site_url: 'https://example.com/', start_date: '2025-10-01' })).content[0]!.text);
  assert.deepEqual(t.data_range, { first: '2025-10-07', last: '2025-10-07' });
  assert.deepEqual(t.source_window, { first: '2025-09-30', last: '2025-10-07' });
  const crawl = bingServer({}, () => json({ d: [{ Date: '/Date(1759215600000-0700)/', CrawledPages: 5 }] }));
  const c = JSON.parse((await crawl.run('bing_get_crawl_stats', { site_url: 'https://example.com/', end_date: '2025-09-01' })).content[0]!.text);
  assert.deepEqual(c.data_range, { first: null, last: null });
  assert.deepEqual(c.source_window, { first: '2025-09-30', last: '2025-09-30' });
});

test('bing_remove_feed validates feed_url before calling Bing', async () => {
  const { run, calls } = bingServer({ GSC_SCOPES: 'full', GSC_ALLOW_DESTRUCTIVE: 'true' }, () => json({ d: null }));
  for (const feed_url of ['not a url', 'ftp://example.com/s.xml', 'https://u:p@example.com/s.xml']) {
    const res = await run('bing_remove_feed', { site_url: 'https://example.com/', feed_url });
    assert.equal(res.isError, true, feed_url);
    assert.match(res.content[0]!.text, /feed_url must be an absolute http\(s\) URL/);
  }
  assert.equal(calls.length, 0);
  assert.equal((await run('bing_remove_feed', { site_url: 'https://example.com/', feed_url: 'https://example.com/s.xml' })).isError, undefined);
  assert.equal(calls[0]!.url.pathname.endsWith('/RemoveFeed'), true);
});

test('bing_submit_urls rejects blank-only lists and URLs with credentials', async () => {
  const { run, calls } = bingServer({ GSC_SCOPES: 'full' }, () => json({ d: null }));
  const blank = await run('bing_submit_urls', { site_url: 'https://example.com/', urls: ['  ', ' '] });
  assert.equal(blank.isError, true);
  assert.match(blank.content[0]!.text, /at least one non-empty URL/);
  const creds = await run('bing_submit_urls', { site_url: 'https://example.com/', urls: ['https://u:p@example.com/a'] });
  assert.equal(creds.isError, true);
  assert.equal(calls.length, 0);
});

test('parseBingDate keeps the calendar day of ISO strings in their own offset', () => {
  assert.deepEqual(parseBingDate('2025-01-01T00:30:00+08:00'), { iso: '2024-12-31T16:30:00.000Z', date: '2025-01-01' });
  assert.deepEqual(parseBingDate('2025-01-01T23:30:00-07:00'), { iso: '2025-01-02T06:30:00.000Z', date: '2025-01-01' });
  assert.deepEqual(parseBingDate('2025-09-16T00:00:00.0000000-0700'), { iso: '2025-09-16T07:00:00.000Z', date: '2025-09-16' });
  // No zone: read as UTC, independent of the server's time zone.
  assert.deepEqual(parseBingDate('2025-03-04T05:06:07'), { iso: '2025-03-04T05:06:07.000Z', date: '2025-03-04' });
  assert.deepEqual(parseBingDate('2025-03-04'), { iso: '2025-03-04T00:00:00.000Z', date: '2025-03-04' });
  assert.equal(parseBingDate('2025-02-30T00:00:00Z'), null);
  assert.equal(parseBingDate('0001-01-01T00:00:00'), null);
});
