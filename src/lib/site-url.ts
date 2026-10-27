/**
 * Resolve a caller-supplied site URL to one Search Console property.
 *
 * Google treats these as different properties even when they share a host:
 * `sc-domain:example.com`, `https://example.com/`, `http://example.com/`,
 * `https://example.com/blog/`. Dropping the property type, scheme, or path
 * would make them compare equal and route a call to the wrong account.
 *
 * Matching rules:
 * 1. Exact identity: type (sc-domain vs URL-prefix), scheme, host
 *    (case-insensitive), and path (case preserved; URL-prefix paths always
 *    have a trailing slash, as Google lists them).
 * 2. Bare domain only (no scheme, no path, no `sc-domain:` prefix): try
 *    `sc-domain:<host>`, `https://<host>/`, `http://<host>/` in that order.
 *    The first property any account lists wins.
 * 3. Otherwise do not guess. If other properties share the host, the caller
 *    gets those candidates; if none do, the input is not found.
 */

export type SiteUrlForm =
  | { form: 'domain'; raw: string; host: string }
  | { form: 'url-prefix'; raw: string; scheme: 'http' | 'https'; host: string; path: string }
  | { form: 'bare'; raw: string; host: string }
  | { form: 'unknown'; raw: string };

export type ResolveSiteUrlResult =
  | { status: 'resolved'; siteUrl: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

export class AmbiguousPropertyError extends Error {
  readonly input: string;
  readonly candidates: readonly string[];

  constructor(input: string, candidates: readonly string[]) {
    const listed = candidates.map((c) => `  - ${c}`).join('\n');
    super(
      `Ambiguous Search Console property '${input}'. ` +
        'Use an exact property URL from list_properties; these properties share this host:\n' +
        listed,
    );
    this.name = 'AmbiguousPropertyError';
    this.input = input;
    this.candidates = candidates;
  }
}

const DOMAIN_PREFIX = 'sc-domain:';

/** Parse a caller-supplied site URL (bare domains stay bare). */
export function parseSiteUrl(input: string): SiteUrlForm {
  const raw = input.trim();
  if (raw === '') return { form: 'unknown', raw };

  if (raw.toLowerCase().startsWith(DOMAIN_PREFIX)) {
    const host = normalizeHost(raw.slice(DOMAIN_PREFIX.length).replace(/\/+$/, ''));
    if (host === '' || host.includes('/')) return { form: 'unknown', raw };
    return { form: 'domain', raw, host };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { form: 'unknown', raw };
      const host = url.hostname.toLowerCase();
      if (host === '') return { form: 'unknown', raw };
      let path = url.pathname === '' ? '/' : url.pathname;
      if (!path.endsWith('/')) path += '/';
      return {
        form: 'url-prefix',
        raw,
        scheme: url.protocol === 'https:' ? 'https' : 'http',
        host,
        path,
      };
    } catch {
      return { form: 'unknown', raw };
    }
  }

  if (isBareDomain(raw)) {
    const host = normalizeHost(raw);
    if (host === '') return { form: 'unknown', raw };
    return { form: 'bare', raw, host };
  }

  return { form: 'unknown', raw };
}

/**
 * Parse a property as Google lists it. A listed value is never a bare
 * domain: if it is not `sc-domain:` or a URL-prefix, it only matches the
 * same trimmed string.
 */
export function parseListedSiteUrl(input: string): SiteUrlForm {
  const parsed = parseSiteUrl(input);
  if (parsed.form === 'bare') return { form: 'unknown', raw: parsed.raw };
  return parsed;
}

/** True when two property strings are the same Search Console property. */
export function sameProperty(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const left = identityKey(parseListedSiteUrl(a));
  const right = identityKey(parseListedSiteUrl(b));
  return left !== null && left === right;
}

/**
 * Pick the listed property that `input` refers to. `listed` is every
 * property any account returned from sites.list (duplicates are fine).
 */
export function resolveSiteUrl(input: string, listed: readonly string[]): ResolveSiteUrlResult {
  const wanted = parseSiteUrl(input);
  const properties = uniqueListed(listed);

  const exact = uniqueByIdentity(properties.filter((p) => listedMatchesInput(wanted, p)));
  if (exact.length === 1) return { status: 'resolved', siteUrl: preferredListed(wanted, exact) };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.map((p) => p.listed) };

  if (wanted.form === 'bare') {
    for (const candidate of bareDomainFallbacks(wanted.host)) {
      const hit = properties.find((p) => listedMatchesInput(parseSiteUrl(candidate), p));
      if (hit) return { status: 'resolved', siteUrl: hit.listed };
    }
  }

  const related = uniqueByIdentity(relatedByHost(wanted, properties));
  if (related.length > 0) return { status: 'ambiguous', candidates: related.map((p) => p.listed) };
  return { status: 'not_found' };
}

/**
 * Rewrite a GSC request so the path and inspection body use the resolved
 * listed property (needed when the caller passed a bare domain or a
 * host-case / trailing-slash variant).
 */
export function rewriteRequestSiteUrl(
  path: string,
  body: unknown,
  resolved: string,
): { path: string; body: unknown } {
  let nextPath = path;
  const m = /^\/webmasters\/v3\/sites\/([^/?]+)(.*)$/.exec(path);
  if (m) {
    nextPath = `/webmasters/v3/sites/${encodeURIComponent(resolved)}${m[2]}`;
  }
  if (typeof body === 'object' && body !== null && Object.prototype.hasOwnProperty.call(body, 'siteUrl')) {
    return { path: nextPath, body: { ...(body as Record<string, unknown>), siteUrl: resolved } };
  }
  return { path: nextPath, body };
}

function isBareDomain(raw: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  if (/[/?#\\]/.test(raw)) return false;
  return normalizeHost(raw) !== '';
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (trimmed === '') return '';
  try {
    return new URL(`https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function identityKey(parsed: SiteUrlForm): string | null {
  if (parsed.form === 'domain') return `domain\t${parsed.host}`;
  if (parsed.form === 'url-prefix') return `url\t${parsed.scheme}\t${parsed.host}\t${parsed.path}`;
  return null;
}

function hostOf(parsed: SiteUrlForm): string | null {
  if (parsed.form === 'domain' || parsed.form === 'url-prefix' || parsed.form === 'bare') return parsed.host;
  return null;
}

interface ListedProperty {
  listed: string;
  parsed: SiteUrlForm;
}

function uniqueListed(listed: readonly string[]): ListedProperty[] {
  const seen = new Set<string>();
  const out: ListedProperty[] = [];
  for (const raw of listed) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ listed: raw, parsed: parseListedSiteUrl(raw) });
  }
  return out;
}

function listedMatchesInput(input: SiteUrlForm, property: ListedProperty): boolean {
  if (input.raw === property.listed || input.raw.trim() === property.listed.trim()) return true;
  const want = identityKey(input.form === 'bare' ? { form: 'unknown', raw: input.raw } : input);
  const have = identityKey(property.parsed);
  return want !== null && want === have;
}

function bareDomainFallbacks(host: string): string[] {
  return [`${DOMAIN_PREFIX}${host}`, `https://${host}/`, `http://${host}/`];
}

function relatedByHost(input: SiteUrlForm, properties: ListedProperty[]): ListedProperty[] {
  const host = hostOf(input);
  if (host === null) return [];
  return properties.filter((p) => hostOf(p.parsed) === host);
}

function uniqueByIdentity(matches: ListedProperty[]): ListedProperty[] {
  const seen = new Set<string>();
  const out: ListedProperty[] = [];
  for (const m of matches) {
    const key = identityKey(m.parsed) ?? `\traw\t${m.listed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Prefer the listed spelling that equals the input; otherwise the first. */
function preferredListed(input: SiteUrlForm, matches: ListedProperty[]): string {
  const trimmed = input.raw.trim();
  return matches.find((m) => m.listed === trimmed)?.listed ?? matches[0]!.listed;
}
