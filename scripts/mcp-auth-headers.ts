/**
 * Request headers for scripts that call a deployed MCP endpoint.
 *
 * - MCP_AUTH_TOKEN → `Authorization: Bearer <token>`.
 * - CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET → Cloudflare Access service
 *   token headers `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
 *
 * Both can be set at once (a server with both Access and MCP_AUTH_TOKEN).
 */
export function mcpAuthHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const headers: Record<string, string> = {};

  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (Cloudflare Access service token), or neither.');
  }
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }

  const token = env.MCP_AUTH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
