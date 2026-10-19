import { createRequire } from 'node:module';

// Lazily resolved so this module stays importable from the Worker entry
// without node:fs being bundled.
const require = createRequire(import.meta.url);

/**
 * Node-only credential-file loading (plan §6: refresh token 注入).
 *
 * Normal users should never hand-copy GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * GOOGLE_REFRESH_TOKEN: `npm run auth -- --out gsc-credentials.json` writes a
 * file, and the server (or stdio entry) reads it via GSC_CREDENTIALS_FILE.
 *
 * Accepted shapes (detected automatically):
 *  - The file written by scripts/auth.ts:   { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN }
 *  - Google's token.json (token.json from any google auth flow):
 *    { client_id, client_secret, refresh_token, ... }
 *
 * Explicit env vars always win over the file. Workers cannot read files —
 * this helper is only called from the Node entries.
 */
export function applyCredentialsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.GSC_CREDENTIALS_FILE;
  if (!file) return null;
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return null; // explicit env wins
  }
  let parsed: Record<string, unknown>;
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return `GSC_CREDENTIALS_FILE is set to '${file}' but could not be read: ${e instanceof Error ? e.message : e}`;
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };

  const clientId = pick('GOOGLE_CLIENT_ID', 'client_id');
  const clientSecret = pick('GOOGLE_CLIENT_SECRET', 'client_secret');
  const refreshToken = pick('GOOGLE_REFRESH_TOKEN', 'refresh_token');
  if (!clientId || !clientSecret || !refreshToken) {
    return `GSC_CREDENTIALS_FILE '${file}' must contain GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN (or client_id/client_secret/refresh_token).`;
  }

  env.GOOGLE_CLIENT_ID ??= clientId;
  env.GOOGLE_CLIENT_SECRET ??= clientSecret;
  env.GOOGLE_REFRESH_TOKEN ??= refreshToken;
  return null;
}
