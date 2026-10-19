import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { buildBearerAuthenticator } from './bearer.js';
import { buildCfAccessAuthenticator } from './cf-access.js';
import { buildNoneAuthenticator } from './none.js';
import type { AuthIdentity, AuthOutcome, Authenticator } from './types.js';

export type { AuthIdentity, AuthOutcome, Authenticator } from './types.js';

export type AuthBuildResult =
  | { ok: true; authenticate: Authenticator }
  | { ok: false; errors: string[] };

/**
 * Compose the authenticator for `MCP_AUTH_MODE` (plan §6.5).
 *
 * Comma-separated modes ALL must pass (defense in depth, §6.5.1). Every check
 * produces an SDK AuthInfo; the last one wins for `authInfo` pass-through to
 * createMcpHandler. Callers must run validateHttpConfig() first — this builder
 * fails closed (503) when startup validation failed.
 *
 * Results are memoized per Config instance: JWKS resolvers and verifiers are
 * stateful and must survive across requests.
 */
export function buildAuthenticator(cfg: Config, startupErrors: string[]): AuthBuildResult {
  const memoized = memo.get(cfg);
  if (memoized) return memoized;
  const result = buildUncached(cfg, startupErrors);
  memo.set(cfg, result);
  return result;
}

const memo = new WeakMap<Config, AuthBuildResult>();

function buildUncached(cfg: Config, startupErrors: string[]): AuthBuildResult {
  if (startupErrors.length > 0) {
    return { ok: false, errors: [...startupErrors] };
  }

  const checks: Authenticator[] = [];
  for (const mode of cfg.auth.modes) {
    switch (mode) {
      case 'bearer':
        checks.push(buildBearerAuthenticator(cfg.auth));
        break;
      case 'none':
        checks.push(buildNoneAuthenticator());
        break;
      case 'cf-access':
        checks.push(buildCfAccessAuthenticator(cfg.auth.cfAccess!));
        break;
      case 'oauth':
        // Rejected by startup validation; stay closed.
        return { ok: false, errors: ["MCP_AUTH_MODE 'oauth' is not implemented in this build (milestone M5)."] };
    }
  }

  if (checks.length === 0) {
    // Defense in depth (review P1-1): never authenticate when there is
    // nothing to check, even if startup validation was somehow bypassed.
    return { ok: false, errors: ['No authentication checks configured (empty MCP_AUTH_MODE).'] };
  }

  return {
    ok: true,
    authenticate: async (req: Request): Promise<AuthOutcome> => {
      let authInfo: AuthInfo | null = null;
      const identities: AuthIdentity[] = [];
      for (const check of checks) {
        const outcome = await check(req);
        if (outcome.kind === 'deny') return outcome;
        authInfo = outcome.authInfo;
        identities.push(...outcome.identities);
      }
      return {
        kind: 'ok',
        identities,
        authInfo: authInfo ?? {
          token: 'none',
          clientId: 'unknown',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        },
      };
    },
  };
}
