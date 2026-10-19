import type { Config } from '../lib/config.js';
import { getConfig } from '../lib/config.js';
import { TokenProvider } from '../lib/auth.js';
import { GscClient } from '../lib/gsc-client.js';
import { parseEncryptionKey } from '../lib/google-oauth/crypto.js';
import { GoogleTokenStore } from '../lib/google-oauth/store.js';

/** Shared, stateless-ish services handed to every tool registration. */
export interface ServerServices {
  config: Config;
  tokenProvider: TokenProvider;
  gsc: GscClient;
  /** Encrypted KV token store; null unless GSC_TOKENS and a valid TOKEN_ENCRYPTION_KEY are present. */
  tokenStore?: GoogleTokenStore | null;
}

let servicesCache: { config: Config; services: ServerServices } | null = null;

export function buildTokenStore(config: Config): GoogleTokenStore | null {
  const { kv, encryptionKey } = config.googleAuth;
  if (!kv || !encryptionKey || !parseEncryptionKey(encryptionKey).ok) return null;
  return new GoogleTokenStore(kv, encryptionKey);
}

/**
 * Services singleton per config instance. The MCP server factory builds a
 * fresh McpServer per request, but the Google token cache and HTTP client are
 * shared (plan §3 请求处理模型).
 */
export function getServices(): ServerServices {
  const config = getConfig();
  if (!servicesCache || servicesCache.config !== config) {
    const tokenStore = buildTokenStore(config);
    const tokenProvider = new TokenProvider(config.google, undefined, { store: tokenStore });
    servicesCache = {
      config,
      services: { config, tokenProvider, gsc: new GscClient({ tokenProvider }), tokenStore },
    };
  }
  return servicesCache.services;
}
