import { GOOGLE_SCOPE_FULL, GOOGLE_SCOPE_READONLY } from '../config.js';
import { base64Decode } from './crypto.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Identifies the authorized Google account: its email keys the stored token. */
const IDENTITY_SCOPES = ['openid', 'email'];

export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...opts.scopes, ...IDENTITY_SCOPES].join(' '));
  url.searchParams.set('access_type', 'offline');
  // consent forces a refresh token even when the account already granted this
  // client; select_account shows the account chooser so another account can be added.
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface CodeExchangeResult {
  refreshToken: string | null;
  /** Short-lived; only used to look up the email when the ID token has none. */
  accessToken: string | null;
  /** Effective scope: Google's `scope` or, when omitted, the requested scopes. */
  scope: string;
  /** Scope string Google actually returned; null when the field was omitted. */
  grantedScope: string | null;
  email: string | null;
}

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

export async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    /** Used as the effective scope when Google omits `scope` (RFC 6749 §5.1). */
    requestedScopes: string[];
  },
): Promise<CodeExchangeResult> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    grant_type: 'authorization_code',
  });
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    throw new GoogleOAuthError(`Failed to reach Google token endpoint: ${e instanceof Error ? e.message : String(e)}`, 'network');
  }
  const data = (await res.json().catch(() => null)) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !data) {
    const code = data?.error ?? `HTTP ${res.status}`;
    throw new GoogleOAuthError(`Google rejected the authorization code (${code}): ${data?.error_description ?? 'no details'}`, code);
  }
  return {
    refreshToken: data.refresh_token ?? null,
    accessToken: data.access_token ?? null,
    scope: data.scope ?? opts.requestedScopes.join(' '),
    grantedScope: typeof data.scope === 'string' && data.scope !== '' ? data.scope : null,
    email: data.id_token ? emailFromIdToken(data.id_token) : null,
  };
}

/**
 * Read the email claim from an ID token received directly from Google's token
 * endpoint over TLS (OIDC Core §3.1.3.7 allows skipping signature validation
 * in that case). Display only; never used for authorization.
 */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64Decode(payload))) as { email?: unknown };
    return typeof claims.email === 'string' && claims.email ? claims.email : null;
  } catch {
    return null;
  }
}

/** Email of the account behind an access token (OIDC userinfo); null when unavailable. */
export async function fetchUserEmail(fetchImpl: typeof fetch, accessToken: string): Promise<string | null> {
  try {
    const res = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { email?: unknown } | null;
    return typeof data?.email === 'string' && data.email ? data.email : null;
  } catch {
    return null;
  }
}

export interface RevokeResult {
  revoked: boolean;
  /** Google answered that the token was already invalid. */
  alreadyInvalid: boolean;
  detail: string | null;
}

export async function revokeGoogleToken(fetchImpl: typeof fetch, token: string): Promise<RevokeResult> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (e) {
    return { revoked: false, alreadyInvalid: false, detail: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.ok) return { revoked: true, alreadyInvalid: false, detail: null };
  const data = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
  if (data?.error === 'invalid_token') {
    return { revoked: false, alreadyInvalid: true, detail: 'Google reports the token was already invalid' };
  }
  return { revoked: false, alreadyInvalid: false, detail: `HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}` };
}

/** Granted scope string covers every required scope (full implies readonly). */
export function scopesCover(granted: string, required: string[]): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return required.every(
    (s) => have.has(s) || (s === GOOGLE_SCOPE_READONLY && have.has(GOOGLE_SCOPE_FULL)),
  );
}

/** True when the grant includes the non-readonly webmasters scope. */
export function hasWebmastersWriteScope(granted: string): boolean {
  return granted.split(/\s+/).filter(Boolean).includes(GOOGLE_SCOPE_FULL);
}
