import type { Config } from '../lib/config.js';
import { getConfig } from '../lib/config.js';
import { TokenProvider } from '../lib/auth.js';
import { GscClient } from '../lib/gsc-client.js';

/** Shared, stateless-ish services handed to every tool registration. */
export interface ServerServices {
  config: Config;
  tokenProvider: TokenProvider;
  gsc: GscClient;
}

let servicesCache: { config: Config; services: ServerServices } | null = null;

/**
 * Services singleton per config instance. The MCP server factory builds a
 * fresh McpServer per request, but the Google token cache and HTTP client are
 * shared (plan §3 请求处理模型).
 */
export function getServices(): ServerServices {
  const config = getConfig();
  if (!servicesCache || servicesCache.config !== config) {
    const tokenProvider = new TokenProvider(config.google);
    servicesCache = {
      config,
      services: { config, tokenProvider, gsc: new GscClient({ tokenProvider }) },
    };
  }
  return servicesCache.services;
}
