import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Authentication outcome.
 *
 * Discriminated union instead of `AuthInfo | Response`: the SDK may build
 * Response objects from a non-global realm (dual ESM/CJS instantiation via
 * @modelcontextprotocol/hono), under which `instanceof Response` silently
 * fails. Never instanceof-check SDK-produced Responses.
 */
export type AuthOutcome =
  | { kind: 'ok'; authInfo: AuthInfo }
  | { kind: 'deny'; response: Response };

export type Authenticator = (req: Request) => Promise<AuthOutcome>;
