/**
 * Request headers for scripts that call a deployed MCP endpoint.
 *
 * - MCP_AUTH_TOKEN → `Authorization: Bearer <token>` (or the raw token in the
 *   header named by MCP_BEARER_HEADER, matching the server's bearer mode).
 * - CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET → Cloudflare Access service
 *   token headers `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
 *
 * Both can be set at once (MCP_AUTH_MODE=cf-access,bearer).
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
  if (token) {
    const header = (env.MCP_BEARER_HEADER ?? 'authorization').toLowerCase();
    if (header === 'authorization') {
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers[header] = token;
    }
  }
  return headers;
}
