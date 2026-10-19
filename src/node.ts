import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { getConfig, validateHttpConfig, validateHttpWarnings } from './lib/config.js';
import { applyCredentialsFile } from './lib/credentials-file.js';

// GSC_CREDENTIALS_FILE → GOOGLE_* env (avoids hand-copying credentials).
const credError = applyCredentialsFile();

const cfg = getConfig();
const errors = validateHttpConfig(cfg, 'node');
if (errors.length > 0) {
  console.error('gsc-mcp-ts: refusing to start (fail closed, plan §6.5.2):');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

for (const w of validateHttpWarnings(cfg)) {
  console.warn(`gsc-mcp-ts: warning: ${w}`);
}
if (credError) {
  console.warn(`gsc-mcp-ts: warning: ${credError}`);
}

const app = buildApp('node');
serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  console.log(
    `gsc-mcp-ts listening on http://${cfg.host}:${info.port}/mcp ` +
    `(auth: ${cfg.auth.rawMode || 'unset'}, scope tier: ${cfg.scopeTier})`,
  );
});
