/**
 * Export a tool's inner JSON result to a file.
 *
 * Usage (server must be running, see npm run dev):
 *   npx tsx scripts/export.ts get_search_analytics out.json \
 *     --site_url sc-domain:example.com --days 28 --row_limit 100
 *
 * Or against any remote MCP_URL with a token:
 *   MCP_URL=https://gsc-mcp.example.com/mcp MCP_AUTH_TOKEN=... npx tsx scripts/export.ts ...
 *
 * Non-JSON results (error text, guidance) are written as-is with a warning.
 */
const [, , tool, outFile, ...rest] = process.argv;

if (!tool || !outFile) {
  console.error('Usage: npx tsx scripts/export.ts <tool> <out.json> [--key value ...]');
  process.exit(1);
}

const args: Record<string, unknown> = {};
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '');
  if (!key) continue;
  const raw = rest[i + 1] ?? '';
  args[key] = /^(true|false)$/.test(raw) ? raw === 'true' : /^\d+$/.test(raw) ? Number(raw) : raw;
}

const url = process.env.MCP_URL ?? 'http://localhost:3001/mcp';
const token = process.env.MCP_AUTH_TOKEN;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  }),
});

const text = await res.text();
const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
const data = JSON.parse(dataLine ? dataLine.slice(6) : text);

if (data.error) {
  console.error(`MCP error: ${data.error.message}`);
  process.exit(1);
}
const inner = data?.result?.content?.[0]?.text;
if (typeof inner !== 'string') {
  console.error('Unexpected result shape:', JSON.stringify(data).slice(0, 300));
  process.exit(1);
}

let output = inner;
try {
  output = JSON.stringify(JSON.parse(inner), null, 2); // pretty-print when it's JSON
} catch {
  console.warn('Result is not JSON — writing raw text.');
}

const { writeFileSync } = await import('node:fs');
writeFileSync(outFile, output + '\n');
console.log(`Wrote ${outFile} (${output.length} bytes)`);
