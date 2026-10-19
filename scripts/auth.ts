/**
 * One-time OAuth bootstrap (plan §6): opens a browser, captures the redirect,
 * exchanges the code and writes a credentials file — no hand-copying needed.
 *
 * Usage:
 *   npm run auth -- --scopes readonly|full \
 *     --client-secrets ~/Downloads/client_secret_xxx.json \
 *     --out gsc-credentials.json
 *
 * --client-secrets: the JSON you downloaded from Google Cloud Console
 *   (APIs & Services → Credentials → OAuth client). If omitted, reads
 *   GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET from env.
 * --out: where to write { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *   GOOGLE_REFRESH_TOKEN }. The server picks it up via GSC_CREDENTIALS_FILE.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const SCOPES = {
  readonly: 'https://www.googleapis.com/auth/webmasters.readonly',
  full: 'https://www.googleapis.com/auth/webmasters',
} as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scopesArg = (arg('scopes') ?? 'readonly').toLowerCase();
const scope = SCOPES[scopesArg as keyof typeof SCOPES];
if (!scope) {
  console.error(`Unknown --scopes '${scopesArg}'. Use readonly or full.`);
  process.exit(1);
}

let clientId = process.env.GOOGLE_CLIENT_ID;
let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const secretsPath = arg('client-secrets');
if (secretsPath) {
  const parsed = JSON.parse(readFileSync(secretsPath, 'utf8')) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const creds = parsed.installed ?? parsed.web;
  if (!creds) {
    console.error(`${secretsPath}: no 'installed' or 'web' client entry.`);
    process.exit(1);
  }
  clientId = creds.client_id;
  clientSecret = creds.client_secret;
}
if (!clientId || !clientSecret) {
  console.error('Need a client: pass --client-secrets <client_secrets.json> or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.');
  process.exit(1);
}

const REDIRECT_HOST = '127.0.0.1';
const oauthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
oauthUrl.searchParams.set('client_id', clientId);
oauthUrl.searchParams.set('redirect_uri', `http://${REDIRECT_HOST}:PORT/callback`);
oauthUrl.searchParams.set('response_type', 'code');
oauthUrl.searchParams.set('scope', scope);
oauthUrl.searchParams.set('access_type', 'offline');
oauthUrl.searchParams.set('prompt', 'consent');

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${REDIRECT_HOST}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    res.writeHead(400).end(`OAuth error: ${error ?? 'no code'}`);
    server.emit('oauth-error' as never, error ?? 'no code');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Authorization received — you can close this tab.</h1>');
  server.emit('oauth-code' as never, code);
});

await new Promise<void>((resolve) => server.listen(0, REDIRECT_HOST, resolve));
const port = (server.address() as { port: number }).port;
const finalUrl = oauthUrl.toString().replace('PORT', String(port));

console.log(`Opening browser for Google authorization (scope: ${scopesArg})…`);
console.log(`If it doesn't open, visit:\n  ${finalUrl}`);
execFile('open', [finalUrl], () => {});

const code: string = await new Promise((resolveCode, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for OAuth redirect (5 min)')), 5 * 60 * 1000);
  timer.unref(); // never keep the process alive by itself (review P2-14)
  const done = (fn: (v: never) => void, v: never) => {
    clearTimeout(timer);
    fn(v);
  };
  server.on('oauth-code' as never, ((c: string) => done(resolveCode as never, c as never)) as never);
  server.on('oauth-error' as never, ((err: string) => done(reject as never, err as never)) as never);
});
server.close();

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `http://${REDIRECT_HOST}:${port}/callback`,
    grant_type: 'authorization_code',
  }).toString(),
});
const tokenJson = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
if (!tokenRes.ok || !tokenJson.refresh_token) {
  console.error(`Token exchange failed: ${tokenJson.error}: ${tokenJson.error_description}`);
  process.exit(1);
}

const creds = {
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
  GOOGLE_REFRESH_TOKEN: tokenJson.refresh_token,
};
const outFile = arg('out') ?? 'gsc-credentials.json';
// Atomic 0600 write (review P2-11): create a fresh 0600 temp file in the
// same directory and rename it over the target. Overwriting an existing
// looser-permission file in place would keep its inode — a read-only FD that
// another user still has open on it could read the NEW refresh token.
const { renameSync, unlinkSync } = await import('node:fs');
const tmpFile = `${outFile}.tmp-${process.pid}`;
try {
  writeFileSync(tmpFile, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmpFile, outFile);
} catch (e) {
  try {
    unlinkSync(tmpFile);
  } catch {
    // best effort cleanup
  }
  console.error(`Failed to write ${outFile}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

console.log(`
✅ Authorization complete. Credentials written to: ${outFile}
Granted scopes: ${tokenJson.scope}

Next steps — pick one:

  Local / Docker (no hand-copying):
    export GSC_CREDENTIALS_FILE=$PWD/${outFile}
    npm run dev                       # local HTTP
    # Docker:  -e GSC_CREDENTIALS_FILE=/run/secrets/gsc -v $PWD/${outFile}:/run/secrets/gsc:ro
    # stdio (Claude Desktop): same export, then connect

  Cloudflare Workers (secrets, 3 commands):
    npx wrangler secret put GOOGLE_CLIENT_ID       # ← ${clientId}
    npx wrangler secret put GOOGLE_CLIENT_SECRET   # ← in ${outFile}
    npx wrangler secret put GOOGLE_REFRESH_TOKEN   # ← in ${outFile}

Warnings (plan §6.2):
- An OAuth consent screen in "Testing" mode makes refresh tokens expire in 7 days — publish as "In production" (or use Internal for Workspace accounts).
- Re-running this script mints a new refresh token; Google silently revokes the oldest beyond 100 per account+client.
- Keep ${outFile} secret — it grants full GSC access. It is gitignored by default? ${outFile === 'gsc-credentials.json' ? 'add it to .gitignore!' : 'make sure it stays private.'}
`);
