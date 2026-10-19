/** Friendly, actionable error messages shared by tools and /health. */

export function siteNotFoundError(siteUrl: string): string {
  return (
    `Site not found: ${siteUrl}\n\n` +
    'Troubleshooting:\n' +
    '1. Run list_properties to see the exact site URLs in your account.\n' +
    '2. Domain properties use the format sc-domain:example.com (no protocol).\n' +
    '3. URL-prefix properties must match exactly, including protocol and trailing slash (e.g. https://example.com/).\n' +
    '4. You must have at least "Restricted" access to the property.'
  );
}

const REFRESH_TOKEN_LIFETIME_NOTE =
  'Note: refresh tokens die early if the OAuth consent screen is in "Testing" mode (7 days), after 6 months unused, or when >100 tokens exist for the same account+client.';

/** invalid_grant for the token stored by the in-Worker flow (KV). */
export const STORED_REFRESH_TOKEN_INVALID_MESSAGE =
  'Google refresh token is invalid, expired, or revoked (invalid_grant).\n' +
  'Fix: open https://<this-worker-host>/auth/google in a browser and authorize again; the new token replaces the stored one.\n' +
  REFRESH_TOKEN_LIFETIME_NOTE;

export const STORED_TOKEN_CLIENT_MISMATCH_MESSAGE =
  'The Google token stored in KV was issued to a different OAuth client than the current GOOGLE_CLIENT_ID, so Google would reject it.\n' +
  'Fix: open https://<this-worker-host>/auth/google and authorize again with the current client.';

/** invalid_grant for GOOGLE_REFRESH_TOKEN from the environment. */
export const REFRESH_TOKEN_INVALID_MESSAGE =
  'Google refresh token is invalid, expired, or revoked (invalid_grant).\n' +
  'Fix (Cloudflare Workers with the GSC_TOKENS KV binding): open https://<this-worker-host>/auth/google and authorize again; ' +
  'the stored token takes precedence over GOOGLE_REFRESH_TOKEN.\n' +
  'Fix (Node / stdio / Workers without KV): re-run the auth bootstrap —\n' +
  '  npm run auth -- --scopes readonly   # or: full\n' +
  'Then update GOOGLE_REFRESH_TOKEN (Docker env / wrangler secret) and restart.\n' +
  REFRESH_TOKEN_LIFETIME_NOTE;

export const CREDENTIALS_MISSING_MESSAGE =
  'Google credentials are not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then either\n' +
  '  - on Cloudflare Workers: open https://<this-worker-host>/auth/google to authorize (needs the GSC_TOKENS KV binding), or\n' +
  '  - set GOOGLE_REFRESH_TOKEN; generate one locally with: npm run auth -- --scopes readonly';
