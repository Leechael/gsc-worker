import type { Config } from '../../lib/config.js';
import type { EngineModule } from '../types.js';
import { BingClient } from './client.js';
import { BING_LABEL, BING_TOOLS, registerBingTools } from './tools.js';

/** Worker secret / env var holding the Bing Webmaster Tools API key. */
export const BING_API_KEY_VAR = 'BING_API_KEY';

export function bingApiKey(config: Config): string | undefined {
  return config.engineEnv[BING_API_KEY_VAR];
}

export const bingEngine: EngineModule = {
  id: 'bing',
  label: BING_LABEL,
  enableVar: BING_API_KEY_VAR,
  enabled: (config) => bingApiKey(config) !== undefined,
  statusLines: () => [
    'Auth: API key (OAuth is not supported yet). On Cloudflare Workers, Bing may answer ThrottleIP because of shared egress IPs; use the Node/stdio entry if it does.',
  ],
  tools: BING_TOOLS,
  register(server, svc, fetchImpl) {
    const apiKey = bingApiKey(svc.config);
    if (!apiKey) return;
    registerBingTools(server, svc, new BingClient(fetchImpl ? { apiKey, fetchImpl } : { apiKey }));
  },
};
