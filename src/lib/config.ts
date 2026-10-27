/**
 * Environment configuration.
 *
 * The env source is indirection-based so the same code runs on Node
 * (process.env) and Cloudflare Workers (per-request bindings): entries call
 * setEnvSource(), and getConfig() re-parses when the source object changes.
 */
import { parseEncryptionKey } from './google-oauth/crypto.js';
import { isKvNamespace, type KvNamespaceLike } from './google-oauth/store.js';

export const VERSION = '0.1.0';

/** Workers KV binding name for the in-Worker Google authorization store. */
export const TOKEN_KV_BINDING = 'GSC_TOKENS';
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

export type EntryKind = 'node' | 'worker' | 'stdio';
export type ScopeTier = 'read' | 'write' | 'destructive';
export type DataState = 'all' | 'final';
export type AuthMode = 'cf-access' | 'bearer' | 'none';

export const GOOGLE_SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_SCOPE_FULL = 'https://www.googleapis.com/auth/webmasters';
export const GOOGLE_SCOPE_ANALYTICS_READONLY = 'https://www.googleapis.com/auth/analytics.readonly';
export const GOOGLE_SCOPE_ANALYTICS = 'https://www.googleapis.com/auth/analytics';
export const GOOGLE_SCOPE_ANALYTICS_EDIT = 'https://www.googleapis.com/auth/analytics.edit';

export interface CfAccessConfig {
  teamDomain: string;
  aud: string[];
}

/**
 * Checks derived from what is configured, all of which must pass:
 * cf-access when CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is set, bearer when
 * MCP_AUTH_TOKEN is set. Neither gives 'none', which startup validation only
 * allows on a loopback Node binding.
 */
export interface AuthConfig {
  modes: AuthMode[];
  bearerToken?: string;
  cfAccess?: CfAccessConfig;
}

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Effective Google scopes for the current tier. */
  scopes: string[];
}

/** In-Worker Google authorization (/auth/google/*). */
export interface GoogleAuthStorageConfig {
  /** GSC_TOKENS KV namespace binding (Workers only). */
  kv?: KvNamespaceLike;
  /** TOKEN_ENCRYPTION_KEY: base64 of 32 random bytes. */
  encryptionKey?: string;
  /** GOOGLE_REDIRECT_URI: overrides the redirect URI derived from the request host. */
  redirectUri?: string;
  /**
   * GOOGLE_AUTH_ADMINS: identities (Access emails, service-token common
   * names, or `static-bearer`) allowed to connect/disconnect Google. Empty
   * means any authenticated identity except Access service tokens.
   */
  admins: string[];
}

export interface Config {
  google: GoogleConfig;
  googleAuth: GoogleAuthStorageConfig;
  /** TOOL_TIER (read|write|destructive), default 'read'. */
  scopeTier: ScopeTier;
  /** TOOL_TIER held a value other than read/write/destructive (treated as read). */
  invalidTier?: string;
  /** Removed settings still present in the environment (named in a startup warning). */
  removedVars: string[];
  /** GSC_DATA_STATE (all|final), default 'all' (matches GSC dashboard). */
  dataState: DataState;
  auth: AuthConfig;
  /** MCP_HOST — bind address for the Node entry. */
  host: string;
  /** MCP_PORT / PORT — default 3001. */
  port: number;
  /** MCP_ALLOWED_HOSTS (required when binding non-loopback). */
  allowedHosts?: string[];
  /** MCP_ALLOWED_ORIGINS (optional). */
  allowedOrigins?: string[];
  /**
   * String settings for the optional search engines in src/engines/, keyed by
   * env name. Only names starting with one of ENGINE_ENV_PREFIXES are kept;
   * each engine parses its own entries.
   */
  engineEnv: Readonly<Record<string, string>>;
}

/** Env name prefixes owned by src/engines/* (add one per new engine). */
export const ENGINE_ENV_PREFIXES = ['BING_', 'INDEXNOW_', 'YANDEX_', 'SEZNAM_'] as const;

type EnvSource = Record<string, unknown>;

let currentSource: EnvSource = (globalThis as { process?: { env: EnvSource } }).process?.env ?? {};
let cache: { source: EnvSource; config: Config } | null = null;

/** Point config parsing at a new env source (Cloudflare Workers bindings). */
export function setEnvSource(src: EnvSource): void {
  if (src !== currentSource) {
    currentSource = src;
    cache = null;
  }
}

function env(key: string): string | undefined {
  const v = currentSource[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function envList(key: string): string[] {
  const v = env(key);
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SCOPE_TIERS: ScopeTier[] = ['read', 'write', 'destructive'];

/** Settings that no longer exist; a leftover one is named in a startup warning. */
const REMOVED_VARS: Record<string, string> = {
  GSC_SCOPES: 'use TOOL_TIER=read|write|destructive',
  GSC_ALLOW_DESTRUCTIVE: 'use TOOL_TIER=destructive',
  GA4_ENABLED: 'grant Analytics per account at /auth/google?ga4=1',
  MCP_AUTH_MODE: 'the checks follow CF_ACCESS_* and MCP_AUTH_TOKEN',
  MCP_BEARER_HEADER: 'send the token in Authorization: Bearer',
  CF_ACCESS_ALLOWED_EMAILS: 'restrict users in the Access policy',
  CF_ACCESS_ALLOWED_SERVICE_TOKENS: 'restrict service tokens in the Access policy',
  GSC_SKIP_OAUTH: 'it never had an effect',
  SEZNAM_API_KEYS: 'put the JSON object in SEZNAM_API_KEY',
};

/** Message for removed settings found in the environment, or null. */
export function removedVarsWarning(names: string[]): string | null {
  if (names.length === 0) return null;
  return `Ignoring removed settings: ${names.map((n) => `${n} (${REMOVED_VARS[n]})`).join('; ')}.`;
}

export function parseConfig(): Config {
  // --- tool tier and Google scope ---
  const rawTier = (env('TOOL_TIER') ?? 'read').toLowerCase().trim();
  const validTier = (SCOPE_TIERS as string[]).includes(rawTier);
  const scopeTier: ScopeTier = validTier ? (rawTier as ScopeTier) : 'read';
  // Google write tools need the full webmasters scope; other engines' keys do not depend on it.
  const scopes = [scopeTier === 'read' ? GOOGLE_SCOPE_READONLY : GOOGLE_SCOPE_FULL];

  // --- GSC_DATA_STATE ---
  const rawDataState = (env('GSC_DATA_STATE') ?? 'all').toLowerCase().trim();
  const dataState: DataState = rawDataState === 'final' ? 'final' : 'all';

  // --- MCP auth: every configured check must pass ---
  const auth: AuthConfig = { modes: [] };
  const teamDomain = env('CF_ACCESS_TEAM_DOMAIN');
  const aud = envList('CF_ACCESS_AUD');
  if (teamDomain || aud.length > 0) {
    auth.modes.push('cf-access');
    auth.cfAccess = { teamDomain: teamDomain ?? '', aud };
  }
  const bearerToken = env('MCP_AUTH_TOKEN');
  if (bearerToken) {
    auth.modes.push('bearer');
    auth.bearerToken = bearerToken;
  }
  if (auth.modes.length === 0) auth.modes.push('none');

  const google: GoogleConfig = { scopes };
  const clientId = env('GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET');
  const refreshToken = env('GOOGLE_REFRESH_TOKEN');
  if (clientId) google.clientId = clientId;
  if (clientSecret) google.clientSecret = clientSecret;
  if (refreshToken) google.refreshToken = refreshToken;

  const googleAuth: GoogleAuthStorageConfig = { admins: envList('GOOGLE_AUTH_ADMINS') };
  const kv = currentSource[TOKEN_KV_BINDING];
  if (isKvNamespace(kv)) googleAuth.kv = kv;
  const encryptionKey = env('TOKEN_ENCRYPTION_KEY');
  if (encryptionKey) googleAuth.encryptionKey = encryptionKey;
  const redirectUri = env('GOOGLE_REDIRECT_URI');
  if (redirectUri) googleAuth.redirectUri = redirectUri;

  const cfg: Config = {
    google,
    googleAuth,
    scopeTier,
    removedVars: Object.keys(REMOVED_VARS).filter((k) => env(k) !== undefined),
    dataState,
    auth,
    host: env('MCP_HOST') ?? '127.0.0.1',
    port: Number.parseInt(env('MCP_PORT') ?? env('PORT') ?? '3001', 10),
    engineEnv: engineEnvFrom(currentSource),
  };
  if (!validTier) cfg.invalidTier = rawTier;
  const allowedHosts = envList('MCP_ALLOWED_HOSTS');
  if (allowedHosts.length > 0) cfg.allowedHosts = allowedHosts;
  const allowedOrigins = envList('MCP_ALLOWED_ORIGINS');
  if (allowedOrigins.length > 0) cfg.allowedOrigins = allowedOrigins;
  return cfg;
}

function engineEnvFrom(src: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (ENGINE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = value.trim();
  }
  return out;
}

export function getConfig(): Config {
  if (!cache || cache.source !== currentSource) {
    cache = { source: currentSource, config: parseConfig() };
  }
  return cache.config;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * §6.5.2 startup validation (fail closed). Returns a list of configuration
 * errors; an empty list means the server may start / serve /mcp.
 *
 * - Node entry: caller must refuse to start when errors are present.
 * - Worker entry: /mcp answers 503 and /health reports ok:false.
 */
export function validateHttpConfig(cfg: Config, entry: 'node' | 'worker'): string[] {
  const errors: string[] = [];

  if (cfg.auth.modes.includes('cf-access')) {
    const cf = cfg.auth.cfAccess;
    if (!cf?.teamDomain) {
      errors.push('Cloudflare Access needs both CF_ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com) and CF_ACCESS_AUD; CF_ACCESS_TEAM_DOMAIN is missing.');
    }
    if (!cf || cf.aud.length === 0) {
      errors.push('Cloudflare Access needs both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (Access application AUD tag); CF_ACCESS_AUD is missing.');
    }
  }
  if (cfg.auth.bearerToken !== undefined && cfg.auth.bearerToken.length < 32) {
    errors.push(`MCP_AUTH_TOKEN is ${cfg.auth.bearerToken.length} bytes; at least 32 bytes are required.`);
  }
  if (cfg.auth.modes.includes('none')) {
    if (entry === 'worker') {
      errors.push('No authentication configured. Cloudflare Workers are public: set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD, or MCP_AUTH_TOKEN.');
    } else if (!isLoopbackHost(cfg.host)) {
      errors.push(`No authentication configured, which is only allowed on a loopback address (MCP_HOST is '${cfg.host}'). Set MCP_AUTH_TOKEN or CF_ACCESS_*.`);
    }
  }

  // --- host / allowedHosts sanity ---
  if (entry === 'node' && !isLoopbackHost(cfg.host) && !cfg.allowedHosts?.length) {
    errors.push(`Binding to non-loopback MCP_HOST '${cfg.host}' requires MCP_ALLOWED_HOSTS (DNS rebinding protection).`);
  }

  errors.push(...validateGoogleAuthStorage(cfg, entry));
  return errors;
}

/** Startup checks for the in-Worker authorization store (fail closed). */
function validateGoogleAuthStorage(cfg: Config, entry: 'node' | 'worker'): string[] {
  const errors: string[] = [];
  const { kv, encryptionKey, redirectUri } = cfg.googleAuth;
  if (entry !== 'worker') return errors;

  if (kv && !encryptionKey) {
    errors.push(
      `KV namespace ${TOKEN_KV_BINDING} is bound but TOKEN_ENCRYPTION_KEY is not set. ` +
        'Refusing to store or read Google tokens unencrypted. Set it with: openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY',
    );
  }
  if (kv && encryptionKey) {
    const parsed = parseEncryptionKey(encryptionKey);
    if (!parsed.ok) errors.push(parsed.error);
  }
  if (redirectUri) {
    let url: URL | null = null;
    try {
      url = new URL(redirectUri);
    } catch {
      errors.push(`GOOGLE_REDIRECT_URI '${redirectUri}' is not an absolute URL.`);
    }
    if (url) {
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
        errors.push(`GOOGLE_REDIRECT_URI must use https (http is only allowed for localhost); got '${redirectUri}'.`);
      }
      if (url.pathname !== GOOGLE_CALLBACK_PATH || url.search || url.hash) {
        errors.push(`GOOGLE_REDIRECT_URI must point at this Worker's ${GOOGLE_CALLBACK_PATH} with no query; got '${redirectUri}'.`);
      }
      if (cfg.allowedHosts && !isLoopbackHost(url.hostname) && !cfg.allowedHosts.some((h) => h.toLowerCase() === url.hostname.toLowerCase())) {
        errors.push(`GOOGLE_REDIRECT_URI host '${url.hostname}' is not in MCP_ALLOWED_HOSTS, so the callback would be rejected.`);
      }
    }
  }
  return errors;
}

/** Body of the fail-closed 503; the actual errors are only logged. */
export const INVALID_CONFIG_MESSAGE =
  'Service unavailable: invalid server configuration. The cause is in the server logs (on Cloudflare: wrangler tail).';

/** Non-fatal configuration warnings (plan §6.1: startup warning). */
export function validateHttpWarnings(cfg: Config, entry: EntryKind = 'node'): string[] {
  const warnings: string[] = [];
  if (entry === 'worker' && !cfg.allowedHosts?.length) {
    warnings.push(
      'MCP_ALLOWED_HOSTS is not set: host validation only accepts localhost, so every request to the deployed ' +
        "Worker's hostname is rejected with 403. Set MCP_ALLOWED_HOSTS to the Worker's public hostname(s).",
    );
  }
  if (cfg.invalidTier !== undefined) {
    warnings.push(`TOOL_TIER '${cfg.invalidTier}' is not one of read, write, destructive; using read.`);
  }
  const removed = removedVarsWarning(cfg.removedVars);
  if (removed) warnings.push(removed);
  if (cfg.googleAuth?.encryptionKey && !cfg.googleAuth.kv) {
    warnings.push(
      `TOKEN_ENCRYPTION_KEY is set but no ${TOKEN_KV_BINDING} KV namespace is bound: in-Worker Google authorization (/auth/google) is disabled ` +
        'and the key is unused (it is always unused on the Node and stdio entries).',
    );
  }
  return warnings;
}
