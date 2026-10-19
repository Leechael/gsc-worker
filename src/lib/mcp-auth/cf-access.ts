import { createRemoteJWKSet, customFetch, jwtVerify, type JSONWebKeySet } from 'jose';
import type { CfAccessConfig } from '../config.js';
import type { AuthOutcome } from './types.js';

export interface CfAccessDeps {
  /** Fetch used for JWKS retrieval (workerd-safe default). */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  jwks?: JSONWebKeySet;
}

function deny(status: 401 | 403, description: string): AuthOutcome {
  return {
    kind: 'deny',
    response: new Response(
      JSON.stringify({ error: status === 401 ? 'unauthorized' : 'forbidden', error_description: description }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer error="${status === 401 ? 'invalid_token' : 'insufficient_scope'}", error_description="${description}"`,
        },
      },
    ),
  };
}

/**
 * Cloudflare Access authenticator (plan §6.5.3).
 *
 * - Reads ONLY the `Cf-Access-Jwt-Assertion` header — never the
 *   `CF_Authorization` cookie (not guaranteed to be forwarded) and never the
 *   plaintext `Cf-Access-Authenticated-User-Email` header (untrusted).
 * - Verifies RS256 signature against the team JWKS
 *   (`<team>/cdn-cgi/access/certs`, keys matched by `kid`, rotated by Access).
 * - Enforces `iss` = team domain and `aud` = the app AUD tag(s).
 * - Identity mapping: user tokens → `clientId = email`; service tokens
 *   (`common_name`, empty `sub`) → `clientId = common_name` (§6.5.3).
 * - Optional server-side allowlists narrow Access policy further (403).
 */
export function buildCfAccessAuthenticator(
  cfg: CfAccessConfig,
  deps: CfAccessDeps = {},
): (req: Request) => Promise<AuthOutcome> {
  const teamDomain = cfg.teamDomain.replace(/\/+$/, '');
  const certsUrl = new URL(`${teamDomain}/cdn-cgi/access/certs`);

  // workerd: bare `fetch` as a default breaks (`this` binding) — wrap it.
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const jwks = deps.jwks
    ? createLocalJWKSet(deps.jwks)
    : createRemoteJWKSet(certsUrl, {
        [customFetch]: (url, options) => fetchImpl(url, options),
      });

  const audience = cfg.aud.length === 1 ? cfg.aud[0]! : [...cfg.aud];

  return async (req: Request): Promise<AuthOutcome> => {
    const token = req.headers.get('cf-access-jwt-assertion');
    if (!token) {
      return deny(401, 'missing Cf-Access-Jwt-Assertion header');
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: teamDomain,
        audience,
        algorithms: ['RS256'],
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (e) {
      return deny(401, `JWT verification failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
    const commonName =
      typeof payload.common_name === 'string' && payload.common_name ? payload.common_name : null;

    if (!email && !commonName) {
      return deny(401, 'token carries no identity (no email/common_name claim)');
    }

    // Optional server-side second allowlist (plan §6.5.3).
    if (email && cfg.allowedEmails.length > 0 && !cfg.allowedEmails.includes(email)) {
      return deny(403, `email '${email}' is not in CF_ACCESS_ALLOWED_EMAILS`);
    }
    if (commonName && cfg.allowedServiceTokens.length > 0 && !cfg.allowedServiceTokens.includes(commonName)) {
      return deny(403, `service token '${commonName}' is not in CF_ACCESS_ALLOWED_SERVICE_TOKENS`);
    }

    const exp = payload.exp;
    if (typeof exp !== 'number') {
      // Fail closed: a token without exp would otherwise get a synthesized
      // expiry and be reusable indefinitely (review P2-13).
      return deny(401, 'token is missing the exp claim');
    }
    return {
      kind: 'ok',
      authInfo: {
        token,
        clientId: email ?? commonName!,
        scopes: [],
        expiresAt: exp,
      },
      identities: [
        email
          // Lowercased: the pending OAuth state is bound to this id, and an
          // email's casing can differ between logins (e.g. one-time PIN).
          ? { mode: 'cf-access', id: email.toLowerCase(), kind: 'user' }
          : { mode: 'cf-access', id: commonName!.toLowerCase(), kind: 'service' },
      ],
    };
  };
}

/** Minimal local JWKS wrapper so tests can inject a static key set. */
function createLocalJWKSet(jwks: JSONWebKeySet) {
  return async (protectedHeader: { kid?: string }) => {
    const kid = protectedHeader.kid;
    const key = jwks.keys.find((k) => k.kid === kid) ?? jwks.keys[0];
    if (!key) throw new Error('no matching JWKS key');
    const { importJWK } = await import('jose');
    return importJWK(key, key.alg ?? 'RS256');
  };
}
