import 'hono';
import type { AuthIdentity } from '../lib/mcp-auth/types.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** JSON body stashed by @modelcontextprotocol/hono's body parser. */
    parsedBody: unknown;
    /** Every identity that passed the MCP authentication checks on /auth/*, joined as `mode:id` (state binding key). */
    authPrincipal: string;
    authIdentities: AuthIdentity[];
  }
}
