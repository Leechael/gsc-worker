/**
 * Picks which connected Google account serves a request for a property.
 *
 * Each account's sites.list is fetched once and kept for ROUTING_TTL_MS (or
 * until the set of accounts changes, or invalidate() is called after an
 * authorization change or a 403). For a property, accounts are tried from
 * the highest permission level down.
 */

export interface SiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

export interface AccountSites {
  account: string;
  /** null when sites.list failed for this account. */
  sites: { siteUrl: string; permissionLevel: string }[] | null;
  error: string | null;
}

/** Higher is better. Unknown levels rank lowest. */
export const PERMISSION_RANK: Readonly<Record<string, number>> = {
  siteOwner: 4,
  siteFullUser: 3,
  siteRestrictedUser: 2,
  siteUnverifiedUser: 1,
};

export const ROUTING_TTL_MS = 5 * 60_000;

export interface PropertyRouterDeps {
  /** Account ids in default-first order. */
  accountIds: () => Promise<string[]>;
  /** sites.list for one account. */
  listSites: (account: string) => Promise<SiteEntry[]>;
  ttlMs?: number;
  now?: () => number;
}

interface RoutingMap {
  signature: string;
  atMs: number;
  byAccount: AccountSites[];
}

export class PropertyRouter {
  private map: RoutingMap | null = null;
  private building: Promise<RoutingMap> | null = null;
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: PropertyRouterDeps) {
    this.ttlMs = deps.ttlMs ?? ROUTING_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Forget the cached map (after an authorization change or a 403). */
  invalidate(): void {
    this.map = null;
    this.building = null;
    this.generation++;
  }

  /** Every account's properties. `fresh` rebuilds the map. */
  async sitesByAccount(opts: { fresh?: boolean } = {}): Promise<AccountSites[]> {
    if (opts.fresh) this.invalidate();
    const ids = await this.deps.accountIds();
    const signature = ids.join('\n');
    const map = this.map;
    if (map && map.signature === signature && this.now() - map.atMs < this.ttlMs) return map.byAccount;
    this.building ??= this.build(ids, signature);
    return (await this.building).byAccount;
  }

  /**
   * Accounts that list `siteUrl`, best permission first (ties keep account
   * order). Empty when no account lists it.
   */
  async candidates(siteUrl: string): Promise<string[]> {
    const ranked: { account: string; rank: number; order: number }[] = [];
    (await this.sitesByAccount()).forEach((a, order) => {
      const entry = a.sites?.find((s) => s.siteUrl === siteUrl);
      if (entry) ranked.push({ account: a.account, rank: PERMISSION_RANK[entry.permissionLevel] ?? 0, order });
    });
    ranked.sort((x, y) => y.rank - x.rank || x.order - y.order);
    return ranked.map((r) => r.account);
  }

  private async build(ids: string[], signature: string): Promise<RoutingMap> {
    const generation = this.generation;
    try {
      const byAccount = await Promise.all(
        ids.map(async (account): Promise<AccountSites> => {
          try {
            const entries = await this.deps.listSites(account);
            return {
              account,
              sites: entries
                .filter((e): e is { siteUrl: string; permissionLevel?: string } => typeof e.siteUrl === 'string')
                .map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel ?? 'unknown' })),
              error: null,
            };
          } catch (e) {
            return { account, sites: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      const map: RoutingMap = { signature, atMs: this.now(), byAccount };
      // A map built across an invalidate() may already be stale; use it once, do not keep it.
      if (generation === this.generation) this.map = map;
      return map;
    } finally {
      if (generation === this.generation) this.building = null;
    }
  }
}

/** The property a GSC request is about: from a /webmasters/v3/sites/{site} path, or a body siteUrl. */
export function siteUrlOfRequest(path: string, body: unknown): string | null {
  const m = /^\/webmasters\/v3\/sites\/([^/?]+)/.exec(path);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return null;
    }
  }
  if (typeof body === 'object' && body !== null) {
    const site = (body as { siteUrl?: unknown }).siteUrl;
    if (typeof site === 'string' && site !== '') return site;
  }
  return null;
}
