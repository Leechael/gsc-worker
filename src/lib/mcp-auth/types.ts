import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Who passed one authentication check.
 * - `user`: a person (Cloudflare Access user token, email)
 * - `service`: a Cloudflare Access service token (common name)
 * - `static`: the shared MCP_AUTH_TOKEN, or `none` on loopback
 */
export interface AuthIdentity {
  mode: 'cf-access' | 'bearer' | 'none';
  id: string;
  kind: 'user' | 'service' | 'static';
}

/**
 * Authentication outcome.
 *
 * Discriminated union instead of `AuthInfo | Response`: the SDK may build
 * Response objects from a non-global realm (dual ESM/CJS instantiation via
 * @modelcontextprotocol/hono), under which `instanceof Response` silently
 * fails. Never instanceof-check SDK-produced Responses.
 *
 * `identities` lists every check that passed (all of them, for combined
 * modes), so callers never lose the Access identity behind a shared bearer.
 */
export type AuthOutcome =
  | { kind: 'ok'; authInfo: AuthInfo; identities: AuthIdentity[] }
  | { kind: 'deny'; response: Response };

export type Authenticator = (req: Request) => Promise<AuthOutcome>;
