import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /** JSON body stashed by @modelcontextprotocol/hono's body parser. */
    parsedBody: unknown;
  }
}
