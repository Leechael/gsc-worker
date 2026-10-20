/**
 * Seznam API keys are per site, so the configuration maps sites to keys:
 *
 *   SEZNAM_API_KEYS = {"example.cz": "<key>", "https://shop.example.cz": "<key>"}
 *   SEZNAM_API_KEY  = "<key>"     (one site; used when no SEZNAM_API_KEYS entry matches)
 *
 * Site labels are host names, optionally with a protocol (Seznam treats
 * http and https as different sites). Matching is case-insensitive and does
 * not strip `www.`.
 */
import type { Config } from '../../lib/config.js';

export const SEZNAM_KEYS_ENV = 'SEZNAM_API_KEYS';
export const SEZNAM_KEY_ENV = 'SEZNAM_API_KEY';
/** Label of the SEZNAM_API_KEY entry. */
export const DEFAULT_SITE = 'default';

export interface SeznamSite {
  label: string;
  key: string;
  /** Lower-case host the label names, or null for the default key. */
  host: string | null;
  /** 'http:' / 'https:' when the label names a protocol. */
  protocol: string | null;
}

export interface SeznamSites {
  sites: SeznamSite[];
  /** Configuration problem (never contains a key). */
  error: string | null;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\/+$/, '');
}

function parseLabel(label: string): { host: string; protocol: string | null } | null {
  try {
    if (/^https?:\/\//i.test(label)) {
      const u = new URL(label);
      return { host: u.host.toLowerCase(), protocol: u.protocol };
    }
    const u = new URL(`https://${label}`);
    if (u.pathname !== '/' || u.search || u.hash) return null;
    return { host: u.host.toLowerCase(), protocol: null };
  } catch {
    return null;
  }
}

export function parseSeznamSites(config: Config): SeznamSites {
  const sites: SeznamSite[] = [];
  let error: string | null = null;
  const raw = config.engineEnv[SEZNAM_KEYS_ENV];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      error = `${SEZNAM_KEYS_ENV} must be a JSON object mapping site to API key, e.g. {"example.cz":"<key>"}; it was ignored.`;
    } else {
      const bad: string[] = [];
      for (const [label, key] of Object.entries(parsed as Record<string, unknown>)) {
        const norm = normalizeLabel(label);
        const target = parseLabel(norm);
        if (typeof key !== 'string' || key.trim() === '' || !target) {
          bad.push(label);
          continue;
        }
        if (sites.some((s) => s.label === norm)) {
          bad.push(label);
          continue;
        }
        sites.push({ label: norm, key: key.trim(), host: target.host, protocol: target.protocol });
      }
      if (bad.length > 0) {
        error = `${SEZNAM_KEYS_ENV}: ignored entries with an invalid site name, a duplicate site, or an empty key: ${bad.join(', ')}.`;
      }
    }
  }
  const single = config.engineEnv[SEZNAM_KEY_ENV];
  if (single) {
    sites.push({ label: DEFAULT_SITE, key: single, host: null, protocol: null });
  }
  return { sites, error };
}

/**
 * Pick the key for a call. `site` names a configured label (or a URL/host on
 * it); otherwise `url` is matched by host. With a single configured site, or
 * no match and SEZNAM_API_KEY set, that key is used.
 */
export function selectSite(all: SeznamSite[], site: string | null | undefined, url?: string | null): SeznamSite {
  const named = all.filter((s) => s.host !== null);
  const fallback = all.find((s) => s.host === null) ?? null;
  const list = () => all.map((s) => s.label).join(', ') || '(none)';

  const byTarget = (value: string): SeznamSite | undefined => {
    const norm = normalizeLabel(value);
    const exact = all.find((s) => s.label === norm);
    if (exact) return exact;
    let host: string;
    let protocol: string | null = null;
    try {
      const u = new URL(/^https?:\/\//i.test(norm) ? norm : `https://${norm}`);
      host = u.host.toLowerCase();
      if (/^https?:\/\//i.test(norm)) protocol = u.protocol;
    } catch {
      return undefined;
    }
    const candidates = named.filter((s) => s.host === host && (s.protocol === null || protocol === null || s.protocol === protocol));
    return candidates.find((s) => s.protocol !== null && s.protocol === protocol) ?? candidates[0];
  };

  if (site) {
    const match = byTarget(site);
    if (match) return match;
    throw new Error(`Seznam site '${site}' is not configured. Configured sites: ${list()}.`);
  }
  if (url) {
    const match = byTarget(url);
    if (match) return match;
    if (fallback) return fallback;
    throw new Error(`No Seznam API key is configured for the site of ${url}. Configured sites: ${list()}.`);
  }
  if (all.length === 1) return all[0]!;
  if (fallback) return fallback;
  throw new Error(`Pass site: several Seznam sites are configured (${list()}).`);
}
