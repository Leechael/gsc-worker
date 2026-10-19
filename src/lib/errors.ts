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

export const REFRESH_TOKEN_INVALID_MESSAGE =
  'Google refresh token is invalid, expired, or revoked (invalid_grant).\n' +
  'Fix: re-run the auth bootstrap —\n' +
  '  npm run auth -- --scopes readonly   # or: full\n' +
  'Then update GOOGLE_REFRESH_TOKEN (Docker env / wrangler secret) and restart.\n' +
  'Note: refresh tokens die early if the OAuth consent screen is in "Testing" mode (7 days), after 6 months unused, or when >100 tokens exist for the same account+client.';

export const CREDENTIALS_MISSING_MESSAGE =
  'Google credentials are not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.\n' +
  'Generate a refresh token locally with: npm run auth -- --scopes readonly';
