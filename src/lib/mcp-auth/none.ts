import type { AuthOutcome } from './types.js';

/**
 * No-op authenticator (plan §6.5.6): stdio and loopback-only local debugging.
 * Only reachable after startup validation confirmed the binding is loopback.
 */
export function buildNoneAuthenticator(): () => Promise<AuthOutcome> {
  return async () => ({
    kind: 'ok' as const,
    authInfo: {
      token: 'none',
      clientId: 'loopback',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
  });
}
