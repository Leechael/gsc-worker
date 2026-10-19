import { buildApp } from './app.js';
import { setEnvSource } from './lib/config.js';
import type { ExecutionContext } from 'hono';

/**
 * Cloudflare Workers entry.
 *
 * The Hono app is built lazily per bindings object: Host/Origin validation
 * middleware captures the config at build time, so building before
 * setEnvSource() would freeze the app at localhost defaults and 403 every
 * real request (review P1-2). Isolates reuse the same env object, so the
 * cached app is rebuilt only when bindings change.
 */
let cachedEnv: Record<string, unknown> | null = null;
let cachedApp: ReturnType<typeof buildApp> | null = null;

function appFor(env: Record<string, unknown>): ReturnType<typeof buildApp> {
  if (!cachedApp || cachedEnv !== env) {
    setEnvSource(env);
    cachedApp = buildApp('worker');
    cachedEnv = env;
  }
  return cachedApp;
}

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    const app = appFor(env);
    return Promise.resolve(app.fetch(request, env, ctx));
  },
};
