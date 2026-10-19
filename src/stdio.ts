import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp/server.js';
import { applyCredentialsFile } from './lib/credentials-file.js';

// stdio takes credentials from the environment per the MCP spec — no HTTP
// authorization involved (plan §6.5.6). GSC_CREDENTIALS_FILE is honored here
// too, so Claude Desktop users don't hand-copy env vars either.
const credError = applyCredentialsFile();
if (credError) console.warn(`gsc-mcp-ts: warning: ${credError}`);

await serveStdio(() => buildMcpServer());
