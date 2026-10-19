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
export type AuthMode = 'cf-access' | 'bearer' | 'oauth' | 'none';

export const GOOGLE_SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_SCOPE_FULL = 'https://www.googleapis.com/auth/webmasters';

export interface CfAccessConfig {
  teamDomain: string;
  aud: string[];
  allowedEmails: string[];
  allowedServiceTokens: string[];
}

export interface AuthConfig {
  /** Raw MCP_AUTH_MODE value. */
  rawMode: string;
  modes: AuthMode[];
  bearerToken?: string;
  /** Header name for bearer mode (default 'authorization'). */
  bearerHeader: string;
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
  scopeTier: ScopeTier;
  /** GSC_DATA_STATE (all|final), default 'all' (matches GSC dashboard). */
  dataState: DataState;
  allowDestructive: boolean;
  /** GSC_SKIP_OAUTH was set: recognized, ignored, warned (TS v1 has no service account). */
  skipOAuthWarn: boolean;
  auth: AuthConfig;
  /** MCP_HOST — bind address for the Node entry. */
  host: string;
  /** MCP_PORT / PORT — default 3001. */
  port: number;
  /** MCP_ALLOWED_HOSTS (required when binding non-loopback). */
  allowedHosts?: string[];
  /** MCP_ALLOWED_ORIGINS (optional). */
  allowedOrigins?: string[];
}

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

function parseBool(key: string): boolean {
  return ['true', '1', 'yes'].includes((env(key) ?? '').toLowerCase());
}

const AUTH_MODES: AuthMode[] = ['cf-access', 'bearer', 'oauth', 'none'];

export function parseConfig(): Config {
  // --- Google auth ---
  const scopeSetting = (env('GSC_SCOPES') ?? 'readonly').toLowerCase().trim();
  const allowDestructive = parseBool('GSC_ALLOW_DESTRUCTIVE');
  let scopes: string[];
  let scopeTier: ScopeTier;
  if (scopeSetting === 'full') {
    scopes = [GOOGLE_SCOPE_FULL];
    scopeTier = allowDestructive ? 'destructive' : 'write';
  } else {
    scopes = [GOOGLE_SCOPE_READONLY];
    scopeTier = 'read';
  }

  // --- GSC_DATA_STATE ---
  const rawDataState = (env('GSC_DATA_STATE') ?? 'all').toLowerCase().trim();
  const dataState: DataState = rawDataState === 'final' ? 'final' : 'all';

  // --- MCP auth ---
  const rawMode = (env('MCP_AUTH_MODE') ?? '').trim();
  const modes = envList('MCP_AUTH_MODE').filter((m): m is AuthMode =>
    (AUTH_MODES as string[]).includes(m),
  );

  const auth: AuthConfig = {
    rawMode,
    modes,
    bearerHeader: (env('MCP_BEARER_HEADER') ?? 'authorization').toLowerCase(),
  };
  const bearerToken = env('MCP_AUTH_TOKEN');
  if (bearerToken) auth.bearerToken = bearerToken;

  const teamDomain = env('CF_ACCESS_TEAM_DOMAIN');
  const aud = envList('CF_ACCESS_AUD');
  if (teamDomain || aud.length > 0) {
    auth.cfAccess = {
      teamDomain: teamDomain ?? '',
      aud,
      allowedEmails: envList('CF_ACCESS_ALLOWED_EMAILS'),
      allowedServiceTokens: envList('CF_ACCESS_ALLOWED_SERVICE_TOKENS'),
    };
  }

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
    dataState,
    allowDestructive,
    skipOAuthWarn: env('GSC_SKIP_OAUTH') !== undefined,
    auth,
    host: env('MCP_HOST') ?? '127.0.0.1',
    port: Number.parseInt(env('MCP_PORT') ?? env('PORT') ?? '3001', 10),
  };
  const allowedHosts = envList('MCP_ALLOWED_HOSTS');
  if (allowedHosts.length > 0) cfg.allowedHosts = allowedHosts;
  const allowedOrigins = envList('MCP_ALLOWED_ORIGINS');
  if (allowedOrigins.length > 0) cfg.allowedOrigins = allowedOrigins;
  return cfg;
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

  if (cfg.auth.rawMode === '') {
    errors.push('MCP_AUTH_MODE is required for HTTP deployments. Set one of: cf-access, bearer, oauth, none (comma-combinable). For local stdio use, run the stdio entry instead.');
  } else {
    const named = new Set(cfg.auth.rawMode.split(',').map((m) => m.trim()).filter(Boolean));
    for (const m of named) {
      if (!(AUTH_MODES as string[]).includes(m)) {
        errors.push(`Unknown MCP_AUTH_MODE '${m}'. Accepted: ${AUTH_MODES.join(', ')}.`);
      }
    }
    if (cfg.auth.modes.length === 0) {
      // e.g. MCP_AUTH_MODE=',' or ', ,' — parses to zero modes; without this
      // guard the authenticator would run zero checks and let everything
      // through (review P1-1).
      errors.push(`MCP_AUTH_MODE '${cfg.auth.rawMode}' contains no valid modes. Accepted: ${AUTH_MODES.join(', ')}.`);
    }
    if (cfg.auth.modes.includes('oauth') && cfg.auth.modes.includes('cf-access')) {
      errors.push("MCP_AUTH_MODE cannot combine 'oauth' with 'cf-access': Access in front takes over the 401/OAuth flow (see plan §6.5.1).");
    }
  }

  // --- per-mode config (fail closed even for not-yet-implemented modes) ---
  if (cfg.auth.modes.includes('cf-access')) {
    const cf = cfg.auth.cfAccess;
    if (!cf?.teamDomain) {
      errors.push("MCP_AUTH_MODE 'cf-access' requires CF_ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com).");
    }
    if (!cf || cf.aud.length === 0) {
      errors.push("MCP_AUTH_MODE 'cf-access' requires CF_ACCESS_AUD (Access application AUD tag).");
    }
  }
  if (cfg.auth.modes.includes('oauth')) {
    if (entry === 'node') {
      errors.push("MCP_AUTH_MODE 'oauth' is only supported on the Cloudflare Workers entry (milestone M5).");
    } else {
      errors.push("MCP_AUTH_MODE 'oauth' is not implemented in this build (milestone M5).");
    }
  }
  if (cfg.auth.modes.includes('bearer')) {
    const token = cfg.auth.bearerToken;
    if (!token) {
      errors.push("MCP_AUTH_MODE 'bearer' requires MCP_AUTH_TOKEN (at least 32 bytes of random data).");
    } else if (token.length < 32) {
      errors.push(`MCP_AUTH_TOKEN is ${token.length} bytes; at least 32 bytes are required.`);
    }
  }
  if (cfg.auth.modes.includes('none')) {
    if (entry === 'worker') {
      errors.push("MCP_AUTH_MODE 'none' is forbidden on Cloudflare Workers (always public). Use cf-access or bearer.");
    } else if (!isLoopbackHost(cfg.host)) {
      errors.push(`MCP_AUTH_MODE 'none' requires binding to a loopback address (MCP_HOST is '${cfg.host}').`);
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

/** Non-fatal configuration warnings (plan §6.1: startup warning). */
export function validateHttpWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (cfg.allowDestructive && cfg.scopeTier !== 'destructive') {
    warnings.push(
      'GSC_ALLOW_DESTRUCTIVE=true has no effect at the readonly scope tier: ' +
        'destructive tools will return upgrade guidance until GSC_SCOPES=full.',
    );
  }
  if (cfg.skipOAuthWarn) {
    warnings.push(
      'GSC_SKIP_OAUTH is set but has no effect in the TypeScript build (no service-account support; plan §6.3).',
    );
  }
  if (cfg.googleAuth?.encryptionKey && !cfg.googleAuth.kv) {
    warnings.push(
      `TOKEN_ENCRYPTION_KEY is set but no ${TOKEN_KV_BINDING} KV namespace is bound: in-Worker Google authorization (/auth/google) is disabled ` +
        'and the key is unused (it is always unused on the Node and stdio entries).',
    );
  }
  return warnings;
}
