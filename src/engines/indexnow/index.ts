import type { Config } from '../../lib/config.js';
import type { EngineModule } from '../types.js';
import { IndexNowClient, isValidIndexNowKey, type IndexNowConfig } from './client.js';
import { INDEXNOW_LABEL, INDEXNOW_TOOLS, registerIndexNowTools } from './tools.js';

/** Worker secret / env var holding the IndexNow key. */
export const INDEXNOW_KEY_VAR = 'INDEXNOW_KEY';
/** Optional var: key file URL, or a path such as /keys/indexnow.txt applied to every host. */
export const INDEXNOW_KEY_LOCATION_VAR = 'INDEXNOW_KEY_LOCATION';

export function indexNowConfig(config: Config): IndexNowConfig | null {
  const key = config.engineEnv[INDEXNOW_KEY_VAR];
  if (!key) return null;
  const cfg: IndexNowConfig = { key };
  const keyLocation = config.engineEnv[INDEXNOW_KEY_LOCATION_VAR];
  if (keyLocation) cfg.keyLocation = keyLocation;
  return cfg;
}

export const indexNowEngine: EngineModule = {
  id: 'indexnow',
  label: INDEXNOW_LABEL,
  enableVar: INDEXNOW_KEY_VAR,
  enabled: (config) => indexNowConfig(config) !== null,
  statusLines(config) {
    const cfg = indexNowConfig(config);
    if (!cfg) return [];
    const lines = [
      cfg.keyLocation
        ? `Key file: ${INDEXNOW_KEY_LOCATION_VAR}=${cfg.keyLocation.split(cfg.key).join('<INDEXNOW_KEY>')}`
        : 'Key file: https://<host>/<INDEXNOW_KEY>.txt (default; set INDEXNOW_KEY_LOCATION to override)',
    ];
    if (!isValidIndexNowKey(cfg.key)) {
      lines.push('⚠️ INDEXNOW_KEY is not a valid IndexNow key (8-128 characters of a-z, A-Z, 0-9, "-"); submissions will be refused.');
    }
    return lines;
  },
  tools: INDEXNOW_TOOLS,
  register(server, svc, fetchImpl) {
    const cfg = indexNowConfig(svc.config);
    if (!cfg) return;
    registerIndexNowTools(server, svc, cfg, new IndexNowClient(cfg.key, fetchImpl ? { fetchImpl } : {}));
  },
};
