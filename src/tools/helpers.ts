import { GscApiError, TokenRefreshError } from '../lib/gsc-client.js';
import { siteNotFoundError } from '../lib/errors.js';
import type { ScopeTier } from '../lib/config.js';

/** Standard text content wrapper for MCP tool results. */
export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return textResult(JSON.stringify(value, null, 2));
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
  if (required === 'destructive') {
    return (
      `Safety: ${tool} modifies your GSC account and is disabled at the current scope tier (${tier}).\n` +
      'To enable it:\n' +
      '  1. Re-authorize with full scope: npm run auth -- --scopes full\n' +
      '  2. Set GSC_SCOPES=full and GSC_ALLOW_DESTRUCTIVE=true in the server environment\n' +
      '  3. Update GOOGLE_REFRESH_TOKEN and restart the server.'
    );
  }
  return (
    `Safety: ${tool} requires the 'webmasters' scope (current tier: ${tier}).\n` +
    'To enable it:\n' +
    '  1. Re-authorize: npm run auth -- --scopes full\n' +
    '  2. Set GSC_SCOPES=full in the server environment\n' +
    '  3. Update GOOGLE_REFRESH_TOKEN and restart the server.'
  );
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
  if (e instanceof TokenRefreshError) {
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
