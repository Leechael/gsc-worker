import type { EngineModule } from '../types.js';
import { SEZNAM_KEY_ENV, parseSeznamSites } from './sites.js';
import { SEZNAM_LABEL, SEZNAM_TOOLS, registerSeznamTools } from './tools.js';

export const seznamEngine: EngineModule = {
  id: 'seznam',
  label: SEZNAM_LABEL,
  enableVar: SEZNAM_KEY_ENV,
  // Enabled once at least one usable site key is configured.
  enabled: (config) => parseSeznamSites(config).sites.length > 0,
  statusLines(config) {
    const { sites, error } = parseSeznamSites(config);
    const lines = [
      `Sites with a key: ${sites.map((s) => s.label).join(', ')}. Keys are per site; seznam_reindex_url also needs a key with write rights.`,
    ];
    if (error) lines.push(`Warning: ${error}`);
    return lines;
  },
  tools: SEZNAM_TOOLS,
  register(server, svc, fetchImpl) {
    registerSeznamTools(server, svc, fetchImpl ? { fetchImpl } : {});
  },
};
