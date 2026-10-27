import { AmbiguousPropertyError, GscApiError, TokenRefreshError } from '../lib/gsc-client.js';
import { siteNotFoundError } from '../lib/errors.js';
import { GOOGLE_SCOPE_FULL, type ScopeTier } from '../lib/config.js';
import { hasWebmastersWriteScope } from '../lib/google-oauth/google.js';
import type { ServerServices } from '../mcp/context.js';

/** Successful text content. Empty datasets use this too — they are not failures. */
export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Failure result. The message is unchanged; `isError` is set so a client can
 * tell a fault from data. Raising would let the SDK prefix the text with
 * "Error executing tool …".
 */
export function errorResult(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return textResult(JSON.stringify(value ?? null, null, 2));
}

/** JSON payload that describes a failed call (validation, refusal, API error). */
export function jsonError(value: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  // JSON.stringify(undefined) is undefined, which is not a valid MCP text block.
  return errorResult(JSON.stringify(value ?? null, null, 2));
}

/**
 * Map library errors to the friendly messages the Python版 fixed
 * (site-not-found guidance, invalid_grant instructions, quota hints).
 */
/**
 * Scope-tier gate (plan §6.1): write/destructive tools never fail with 403 —
 * they return upgrade guidance when the current tier is insufficient.
 * Returns the guidance message, or null when the tool may proceed.
 */
export function tierGateMessage(tier: ScopeTier, tool: string, required: 'write' | 'destructive'): string | null {
  const order: ScopeTier[] = ['read', 'write', 'destructive'];
  if (order.indexOf(tier) >= order.indexOf(required)) return null;
  const what = required === 'destructive'
    ? `${tool} modifies your GSC account and is disabled at the current tool tier (${tier}).`
    : `${tool} requires the 'webmasters' scope (current tool tier: ${tier}).`;
  return (
    `Safety: ${what}\n` +
    'To enable it:\n' +
    `  1. Set TOOL_TIER=${required} in the server environment and restart (or redeploy).\n` +
    '  2. Re-authorize Google with the full webmasters scope: open /auth/google on Workers,\n' +
    '     or run npm run auth -- --scopes full and update GOOGLE_REFRESH_TOKEN on Node.'
  );
}

type ToolErrorResult = { isError: true; content: { type: 'text'; text: string }[] };

/**
 * Write-tier check against the scope Google granted to the account that
 * owns `siteUrl` (or `account` when the caller already chose one). Unknown
 * granted scope falls back to the scope TOOL_TIER requests. Returns a structured error with
 * a `resolution` field instead of passing Google's 403 through.
 */
export async function grantedWriteGate(
  svc: ServerServices,
  tool: string,
  required: 'write',
  siteUrl: string | null,
  account?: string | null,
): Promise<ToolErrorResult | null> {
  return accountCannotWriteResult(svc, tool, siteUrl, account ?? null);
}

/** Same check as grantedWriteGate, for destructive tools that already have a deployment-level gate. */
export async function accountCannotWriteResult(
  svc: ServerServices,
  tool: string,
  siteUrl: string | null,
  account: string | null,
): Promise<ToolErrorResult | null> {
  const ids = await svc.gsc.accountIds();
  let accountId = account && account.trim() !== '' ? account.trim().toLowerCase() : null;
  if (accountId === null && ids.length === 1) {
    accountId = ids[0] ?? null;
  }
  if (accountId === null && siteUrl && ids.length > 1) {
    const resolved = await svc.gsc.router.resolve(siteUrl);
    if (resolved.status === 'ambiguous') {
      return errorResult(`Error: ${new AmbiguousPropertyError(siteUrl, resolved.candidates).message}`);
    }
    if (resolved.status === 'resolved' && resolved.accounts[0]) {
      accountId = resolved.accounts[0];
    }
  }
  if (accountId === null) {
    accountId = ids[0] ?? null;
  }

  const accounts = await svc.tokenProvider.accounts();
  const chosen = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const granted = chosen?.stored?.grantedScope ?? null;
  const effective = granted ?? svc.config.google.scopes.join(' ');
  if (hasWebmastersWriteScope(effective)) return null;

  const name = chosen?.email ?? chosen?.id ?? accountId ?? 'the connected Google account';
  return jsonError({
    error: 'insufficient_granted_scope',
    tool,
    account: name,
    granted_scope: granted ?? 'unknown',
    required_scope: GOOGLE_SCOPE_FULL,
    resolution:
      `Re-authorize ${name} at /auth/google (with TOOL_TIER=write or destructive) so Google grants the ` +
      'webmasters (non-readonly) scope. Write tools use the scope Google actually granted ' +
      'to that account.',
  });
}

/**
 * Format an API timestamp (RFC 3339, interpreted as UTC like the Python版)
 * as "YYYY-MM-DD HH:MM". Returns the raw string when unparseable.
 */
export function formatDateTime(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function errorText(prefix: string, e: unknown, siteUrl?: string): string {
  if (e instanceof TokenRefreshError || e instanceof AmbiguousPropertyError) {
    return `Error: ${e.message}`;
  }
  if (e instanceof GscApiError) {
    if (e.status === 404 && siteUrl) return siteNotFoundError(siteUrl);
    if (e.status === 429 || (e.reason && e.reason === 'quotaExceeded')) {
      return `Error: API quota exceeded. Please try again later (short-term quota: wait ~15 minutes).`;
    }
    if (e.status === 401 || e.status === 403) {
      return `Error: Permission denied (HTTP ${e.status}). You may need a higher scope tier — see get_capabilities. Details: ${e.message}`;
    }
    return `Error: ${prefix}: ${e.message} (HTTP ${e.status})`;
  }
  return `Error: ${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}
