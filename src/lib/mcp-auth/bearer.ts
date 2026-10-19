import {
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { AuthConfig } from '../config.js';
import type { AuthOutcome } from './types.js';

/** AuthInfo validity for static tokens: satisfy the SDK's "must have expiresAt" rule. */
const AUTHINFO_TTL_SEC = 300;

async function sha256Hex(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Constant-time comparison of two SHA-256 digests (byte-wise XOR, no early exit). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}

function makeVerifier(expectedToken: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const [a, b] = await Promise.all([sha256Hex(token), sha256Hex(expectedToken)]);
      if (!constantTimeEqual(a, b)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid bearer token');
      }
      return {
        token,
        clientId: 'static-bearer',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + AUTHINFO_TTL_SEC,
      };
    },
  };
}

/**
 * Static-token authenticator (plan §6.5.4).
 *
 * Reads `Authorization: Bearer <token>` by default, or the raw token from
 * `MCP_BEARER_HEADER` (e.g. `x-api-key`) when configured — needed when the
 * single-header Cloudflare Access service-token mode occupies Authorization.
 */
export function buildBearerAuthenticator(cfg: AuthConfig): (req: Request) => Promise<AuthOutcome> {
  const verifier = makeVerifier(cfg.bearerToken!);
  const header = cfg.bearerHeader;

  return async (req: Request): Promise<AuthOutcome> => {
    try {
      if (header === 'authorization') {
        const authInfo = await verifyBearerToken(req.headers.get('authorization'), { verifier });
        return { kind: 'ok', authInfo };
      }
      const raw = req.headers.get(header);
      if (!raw) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `missing ${header} header`);
      }
      return { kind: 'ok', authInfo: await verifier.verifyAccessToken(raw) };
    } catch (e) {
      // The SDK's challenge Response may come from a foreign realm; rebuild it
      // with global classes so downstream (Hono, Workers) handles it uniformly.
      const foreign = bearerAuthChallengeResponse(e);
      return {
        kind: 'deny',
        response: new Response(foreign.body, {
          status: foreign.status,
          headers: foreign.headers,
        }),
      };
    }
  };
}
