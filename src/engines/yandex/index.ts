import type { Config } from '../../lib/config.js';
import type { EngineModule } from '../types.js';
import { YANDEX_LABEL, YANDEX_TOOLS, registerYandexTools } from './tools.js';

/** Worker secret / env var holding the Yandex OAuth token. */
export const YANDEX_TOKEN_VAR = 'YANDEX_OAUTH_TOKEN';

export function yandexToken(config: Config): string | undefined {
  return config.engineEnv[YANDEX_TOKEN_VAR];
}

export const yandexEngine: EngineModule = {
  id: 'yandex',
  label: YANDEX_LABEL,
  enableVar: YANDEX_TOKEN_VAR,
  enabled: (config) => yandexToken(config) !== undefined,
  statusLines: () => [
    'Auth: OAuth token from oauth.yandex.com (manual flow; valid for about 6 months, then replace the secret). An in-Worker OAuth flow is a follow-up.',
  ],
  tools: YANDEX_TOOLS,
  register(server, svc, fetchImpl) {
    const token = yandexToken(svc.config);
    if (!token) return;
    registerYandexTools(server, svc, fetchImpl ? { token, fetchImpl } : { token });
  },
};
