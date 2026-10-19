import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /** JSON body stashed by @modelcontextprotocol/hono's body parser. */
    parsedBody: unknown;
    /** Identity that passed MCP_AUTH_MODE on /auth/* (Access email, service token, or static bearer). */
    authPrincipal: string;
  }
}
