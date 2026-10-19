import type { Context, Hono } from 'hono';
import type { Config } from '../config.js';
import { GOOGLE_CALLBACK_PATH, INVALID_CONFIG_MESSAGE, isLoopbackHost, TOKEN_KV_BINDING } from '../config.js';
import type { AuthBuildResult, AuthIdentity } from '../mcp-auth/index.js';
import type { ServerServices } from '../../mcp/context.js';
import { pkceChallenge, randomToken } from './crypto.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  GoogleOAuthError,
  revokeGoogleToken,
  scopesCover,
} from './google.js';

export const AUTH_BASE_PATH = '/auth/google';

export interface GoogleAuthRouteDeps {
  entry: 'node' | 'worker';
  config: () => Config;
  auth: () => AuthBuildResult;
  services: () => ServerServices;
  fetchImpl?: typeof fetch;
}

type RedirectUriResult = { ok: true; uri: string } | { ok: false; error: string };

/**
 * GOOGLE_REDIRECT_URI when set, else derived from the request Host — which
 * must be in MCP_ALLOWED_HOSTS so a forged Host cannot steer the redirect.
 * Loopback hosts (wrangler dev) keep their scheme and port.
 */
export function resolveRedirectUri(cfg: Config, requestUrl: string, hostHeader: string | undefined): RedirectUriResult {
  if (cfg.googleAuth.redirectUri) return { ok: true, uri: cfg.googleAuth.redirectUri };
  if (!hostHeader) return { ok: false, error: 'Request has no Host header; set GOOGLE_REDIRECT_URI.' };
  let host: URL;
  try {
    host = new URL(`http://${hostHeader}`);
  } catch {
    return { ok: false, error: `Invalid Host header '${hostHeader}'.` };
  }
  const hostname = host.hostname.toLowerCase();
  if (isLoopbackHost(hostname)) {
    const scheme = new URL(requestUrl).protocol;
    return { ok: true, uri: `${scheme}//${host.host}${GOOGLE_CALLBACK_PATH}` };
  }
  if (!cfg.allowedHosts?.some((h) => h.toLowerCase() === hostname)) {
    return {
      ok: false,
      error: `Host '${hostname}' is not in MCP_ALLOWED_HOSTS; add it there or set GOOGLE_REDIRECT_URI.`,
    };
  }
  return { ok: true, uri: `https://${hostname}${GOOGLE_CALLBACK_PATH}` };
}

/**
 * In-Worker Google authorization (single Google account per deployment):
 *
 *   GET  /auth/google           → 302 to Google consent (state + PKCE S256)
 *   GET  /auth/google/callback  → exchange code, store encrypted refresh token
 *   GET  /auth/google/status    → source / scope / account / stored-at (no secrets)
 *   POST /auth/google/revoke    → revoke at Google, delete stored token
 *
 * Every route sits behind the same MCP_AUTH_MODE check as /mcp (plus the
 * global Host/Origin validation). The pending state is bound to the identity
 * that started the flow, so a callback must come from that same identity.
 * On the Node entry the routes answer 404: Node keeps `npm run auth` +
 * GSC_CREDENTIALS_FILE.
 */
export function registerGoogleAuthRoutes(app: Hono, deps: GoogleAuthRouteDeps): void {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  app.use('/auth/*', gate);

  async function gate(c: Context, next: () => Promise<void>): Promise<Response | void> {
    if (deps.entry !== 'worker') {
      return c.json(
        {
          error: 'not_available',
          error_description:
            'In-server Google authorization is only available on the Cloudflare Workers entry. ' +
            'On Node, run `npm run auth -- --out gsc-credentials.json` and set GSC_CREDENTIALS_FILE.',
        },
        404,
      );
    }
    const gateResult = deps.auth();
    if (!gateResult.ok) {
      return c.text(INVALID_CONFIG_MESSAGE, 503);
    }
    const outcome = await gateResult.authenticate(c.req.raw);
    if (outcome.kind === 'deny') return outcome.response;
    c.set('authIdentities', outcome.identities);
    c.set('authPrincipal', outcome.identities.map((i) => `${i.mode}:${i.id}`).join(','));
    await next();
  }

  app.get(AUTH_BASE_PATH, async (c) => {
    const cfg = deps.config();
    const svc = deps.services();
    const denied = adminProblem(cfg, c.get('authIdentities'));
    if (denied) return respond(c, 403, 'Not allowed', { error: 'forbidden', error_description: denied });
    const unavailable = storageProblem(cfg, svc) ?? clientProblem(cfg);
    if (unavailable) return respond(c, 503, 'Authorization unavailable', { error: 'not_configured', error_description: unavailable });

    const redirect = resolveRedirectUri(cfg, c.req.url, c.req.header('host'));
    if (!redirect.ok) return respond(c, 400, 'Authorization unavailable', { error: 'invalid_redirect_uri', error_description: redirect.error });

    const state = randomToken();
    const codeVerifier = randomToken();
    await svc.tokenStore!.putState(state, {
      codeVerifier,
      principal: c.get('authPrincipal'),
      redirectUri: redirect.uri,
      createdAt: new Date().toISOString(),
    });
    const location = buildAuthorizationUrl({
      clientId: cfg.google.clientId!,
      redirectUri: redirect.uri,
      scopes: cfg.google.scopes,
      state,
      codeChallenge: await pkceChallenge(codeVerifier),
    });
    return new Response(null, { status: 302, headers: { Location: location, ...SECURITY_HEADERS } });
  });

  app.get(`${AUTH_BASE_PATH}/callback`, async (c) => {
    const cfg = deps.config();
    const svc = deps.services();
    const denied = adminProblem(cfg, c.get('authIdentities'));
    if (denied) return respond(c, 403, 'Not allowed', { error: 'forbidden', error_description: denied });
    const unavailable = storageProblem(cfg, svc) ?? clientProblem(cfg);
    if (unavailable) return respond(c, 503, 'Authorization failed', { error: 'not_configured', error_description: unavailable });

    const redirect = resolveRedirectUri(cfg, c.req.url, c.req.header('host'));
    if (!redirect.ok || !callbackHostMatches(redirect.uri, c.req.header('host'))) {
      return respond(c, 400, 'Authorization failed', {
        error: 'invalid_redirect_uri',
        error_description: redirect.ok
          ? `The callback must arrive on ${new URL(redirect.uri).host} (GOOGLE_REDIRECT_URI).`
          : redirect.error,
      });
    }
    const state = c.req.query('state');
    const taken = state ? await svc.tokenStore!.takeState(state, c.get('authPrincipal')) : { status: 'missing' as const };
    const googleError = c.req.query('error');
    if (googleError) {
      return respond(c, 400, 'Authorization was not completed', {
        error: 'access_denied',
        error_description: `Google returned '${oauthErrorCode(googleError)}'. Open ${AUTH_BASE_PATH} to try again.`,
      });
    }
    const code = c.req.query('code');
    if (!state || !code) {
      return respond(c, 400, 'Authorization failed', { error: 'invalid_request', error_description: 'Missing code or state parameter.' });
    }
    if (taken.status === 'mismatch') {
      return respond(c, 403, 'Authorization failed', {
        error: 'state_mismatch',
        error_description: 'This authorization was started by a different identity.',
      });
    }
    if (taken.status === 'missing') {
      return respond(c, 400, 'Authorization failed', {
        error: 'invalid_state',
        error_description: `This authorization request is unknown, expired, or was already used. Open ${AUTH_BASE_PATH} to start again.`,
      });
    }
    const record = taken.record;
    if (redirect.uri !== record.redirectUri) {
      return respond(c, 400, 'Authorization failed', {
        error: 'invalid_redirect_uri',
        error_description: 'The callback arrived on a different host than the one the authorization started from.',
      });
    }

    let result;
    try {
      result = await exchangeAuthorizationCode(fetchImpl, {
        clientId: cfg.google.clientId!,
        clientSecret: cfg.google.clientSecret!,
        code,
        redirectUri: record.redirectUri,
        codeVerifier: record.codeVerifier,
        requestedScopes: cfg.google.scopes,
      });
    } catch (e) {
      const message = e instanceof GoogleOAuthError ? e.message : 'Google token exchange failed.';
      return respond(c, 502, 'Authorization failed', { error: 'token_exchange_failed', error_description: message });
    }
    if (!result.refreshToken) {
      return respond(c, 502, 'Authorization failed', {
        error: 'no_refresh_token',
        error_description: `Google did not return a refresh token. Open ${AUTH_BASE_PATH} again and approve the consent screen.`,
      });
    }
    if (!scopesCover(result.scope, cfg.google.scopes)) {
      return respond(c, 400, 'Authorization failed', {
        error: 'insufficient_scope',
        error_description: `Google did not grant the required Search Console scope (${cfg.google.scopes.join(' ')}). ` +
          `Open ${AUTH_BASE_PATH} again and keep the Search Console permission checked.`,
      });
    }

    let meta;
    try {
      meta = await svc.tokenStore!.save(result.refreshToken, {
        scope: result.scope,
        clientId: cfg.google.clientId!,
        ...(result.email ? { email: result.email } : {}),
      });
    } catch (e) {
      // The new refresh token is lost, but Google keeps the grant: a new
      // consent reuses it. Do not revoke it, as that would also revoke the
      // previously stored token for the same account and client.
      console.error(`gsc-mcp-ts: storing the Google refresh token failed: ${e instanceof Error ? e.message : String(e)}`);
      return respond(c, 503, 'Authorization failed', {
        error: 'storage_failed',
        error_description: `Google authorized the request, but the token could not be saved to KV. Open ${AUTH_BASE_PATH} to try again.`,
      });
    }
    svc.tokenProvider.reset();
    if (wantsHtml(c)) {
      // Post/redirect/get: a reload must not resubmit the used code, and the
      // code-bearing URL should not stay the current history entry.
      return new Response(null, {
        status: 303,
        headers: { Location: `${AUTH_BASE_PATH}/status?connected=1`, ...SECURITY_HEADERS },
      });
    }
    return respond(c, 200, 'Google Search Console connected', {
      ok: true,
      email: meta.email ?? null,
      scope: meta.scope,
      stored_at: meta.storedAt,
    });
  });

  app.get(`${AUTH_BASE_PATH}/status`, async (c) => {
    const cfg = deps.config();
    const svc = deps.services();
    const status = await svc.tokenProvider.status({ fresh: true });
    const redirect = resolveRedirectUri(cfg, c.req.url, c.req.header('host'));
    return respond(c, 200, 'Google authorization status', {
      active_source: status.source,
      client_configured: status.clientConfigured,
      storage: {
        kv_bound: Boolean(cfg.googleAuth.kv),
        ready: Boolean(svc.tokenStore),
      },
      stored: status.stored
        ? {
            email: status.stored.email ?? null,
            scope: status.stored.scope,
            stored_at: status.stored.storedAt,
            covers_required_scope: scopesCover(status.stored.scope, cfg.google.scopes),
            client_matches: status.stored.clientId === cfg.google.clientId,
          }
        : null,
      env_refresh_token_configured: Boolean(cfg.google.refreshToken),
      required_scopes: cfg.google.scopes,
      redirect_uri: redirect.ok ? redirect.uri : null,
      last_error: status.error,
    }, { disconnect: status.source === 'kv' });
  });

  app.post(`${AUTH_BASE_PATH}/revoke`, async (c) => {
    const cfg = deps.config();
    const svc = deps.services();
    const csrf = crossSiteProblem(c);
    if (csrf) return respond(c, 403, 'Disconnect refused', { error: 'forbidden', error_description: csrf });
    const denied = adminProblem(cfg, c.get('authIdentities'));
    if (denied) return respond(c, 403, 'Not allowed', { error: 'forbidden', error_description: denied });
    const unavailable = storageProblem(cfg, svc);
    if (unavailable) return respond(c, 503, 'Disconnect unavailable', { error: 'not_configured', error_description: unavailable });

    let refreshToken: string | null = null;
    let readError: string | null = null;
    try {
      refreshToken = (await svc.tokenStore!.loadRefreshToken())?.refreshToken ?? null;
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e);
    }
    if (!refreshToken && !readError) {
      return respond(c, 404, 'Nothing to disconnect', {
        revoked: false,
        deleted: false,
        error_description: cfg.google.refreshToken
          ? 'No token is stored in KV. GOOGLE_REFRESH_TOKEN from the environment is still active; remove it with `npx wrangler secret delete GOOGLE_REFRESH_TOKEN`.'
          : 'No token is stored in KV.',
      });
    }

    // Delete locally first: if KV fails, nothing was revoked and the stored
    // token still works. If Google then cannot be reached, the grant may stay
    // live there, which the response says explicitly.
    await svc.tokenStore!.clear();
    svc.tokenProvider.reset();
    const google = refreshToken
      ? await revokeGoogleToken(fetchImpl, refreshToken)
      : { revoked: false, alreadyInvalid: false, detail: readError };
    const revokedAtGoogle = google.revoked || google.alreadyInvalid;
    return respond(c, 200, 'Google Search Console disconnected', {
      deleted: true,
      revoked: revokedAtGoogle,
      ...(revokedAtGoogle
        ? {}
        : {
            warning: `Could not revoke the grant at Google (${google.detail ?? 'unknown error'}). ` +
              'Remove access manually at https://myaccount.google.com/permissions.',
          }),
      active_source: cfg.google.refreshToken ? 'env' : 'none',
    });
  });
}

/**
 * Connecting or disconnecting Google changes which account every MCP client
 * reads, so it is narrower than /mcp access: GOOGLE_AUTH_ADMINS when set,
 * otherwise anyone authenticated except Access service tokens (which are
 * issued to MCP clients, not to the operator).
 */
export function adminProblem(cfg: Config, identities: AuthIdentity[]): string | null {
  const admins = cfg.googleAuth.admins.map((a) => a.toLowerCase());
  if (admins.length > 0) {
    if (identities.some((i) => admins.includes(i.id.toLowerCase()))) return null;
    return 'Only identities listed in GOOGLE_AUTH_ADMINS may connect or disconnect Google.';
  }
  if (identities.some((i) => i.kind === 'service')) {
    return 'Cloudflare Access service tokens may not connect or disconnect Google. Sign in as a user, or list the token in GOOGLE_AUTH_ADMINS.';
  }
  return null;
}

function storageProblem(cfg: Config, svc: ServerServices): string | null {
  if (!cfg.googleAuth.kv) {
    return `In-Worker authorization needs the ${TOKEN_KV_BINDING} KV namespace binding (see wrangler.jsonc).`;
  }
  if (!svc.tokenStore) {
    return 'TOKEN_ENCRYPTION_KEY is missing or invalid; tokens are never stored unencrypted. Generate one with: openssl rand -base64 32';
  }
  return null;
}

function clientProblem(cfg: Config): string | null {
  if (!cfg.google.clientId || !cfg.google.clientSecret) {
    return 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (Google OAuth client of type "Web application").';
  }
  return null;
}

/**
 * The revoke endpoint changes state, so refuse browser requests from other
 * sites even if an ambient Access cookie would authenticate them.
 */
function crossSiteProblem(c: Context): string | null {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return 'Cross-site request refused.';
  }
  const origin = c.req.header('origin');
  if (origin) {
    let same = false;
    try {
      // Scheme and port count: http://host is a different origin from https://host.
      const expected = new URL(`${new URL(c.req.url).protocol}//${c.req.header('host') ?? ''}`).origin;
      same = new URL(origin).origin === expected;
    } catch {
      // unparseable Origin or Host is refused
    }
    if (!same) return 'Cross-origin request refused.';
  }
  return null;
}

/**
 * Google sends the browser to the redirect URI's host, so a callback served
 * on any other host (possible when GOOGLE_REDIRECT_URI is pinned and several
 * hosts are allowed) is refused. Loopback redirect URIs are exempt because
 * wrangler dev rewrites the Host header to the route's hostname.
 */
function callbackHostMatches(redirectUri: string, hostHeader: string | undefined): boolean {
  const expected = new URL(redirectUri);
  if (isLoopbackHost(expected.hostname)) return true;
  return (hostHeader ?? '').toLowerCase() === expected.host.toLowerCase();
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  // The callback URL carries the authorization code; never leak it via Referer.
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const HTML_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
};

/** Browsers get a small HTML page; everything else (curl, scripts, ?format=json) gets JSON. */
function wantsHtml(c: Context): boolean {
  if (c.req.query('format') === 'json') return false;
  return (c.req.header('accept') ?? '').includes('text/html');
}

/** Google's `error` callback parameter is a short ASCII code; anything else is not echoed. */
function oauthErrorCode(raw: string): string {
  return /^[a-z_]{1,64}$/.test(raw) ? raw : 'unknown_error';
}

function respond(
  c: Context,
  status: number,
  title: string,
  data: Record<string, unknown>,
  opts: { disconnect?: boolean } = {},
): Response {
  if (!wantsHtml(c)) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  return new Response(renderPage(title, data, opts.disconnect ?? false), { status, headers: HTML_HEADERS });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '<em>none</em>';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return renderTable(value as Record<string, unknown>);
  }
  return escapeHtml(Array.isArray(value) ? value.join(' ') : String(value));
}

function renderTable(data: Record<string, unknown>): string {
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><th>${escapeHtml(k.replace(/_/g, ' '))}</th><td>${renderValue(v)}</td></tr>`)
    .join('');
  return `<table>${rows}</table>`;
}

function renderPage(title: string, data: Record<string, unknown>, disconnect: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1f2328;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;vertical-align:top;padding:.35rem .5rem;border-bottom:1px solid #d0d7de}
th{width:14rem;font-weight:600;text-transform:capitalize}td table{margin:0}
nav{display:flex;gap:1rem;align-items:center;margin-top:1.5rem}
a,button{font:inherit}button{padding:.35rem .9rem}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${renderTable(data)}
<nav>
<a href="${AUTH_BASE_PATH}">Authorize Google</a>
<a href="${AUTH_BASE_PATH}/status">Status</a>
${disconnect ? `<form method="post" action="${AUTH_BASE_PATH}/revoke"><button type="submit">Disconnect</button></form>` : ''}
</nav>
</body>
</html>
`;
}
