/**
 * Local cf-access e2e helper: serves a fake team JWKS so the real server's
 * cf-access mode can be tested end-to-end without Cloudflare.
 *
 * Prints the env for the main server and the tokens to send.
 */
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';

const TEAM_PORT = 39901;
const TEAM = `http://127.0.0.1:${TEAM_PORT}`;

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'local-test-key';
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };

  createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(jwks));
    } else {
      res.writeHead(404).end('not found');
    }
  }).listen(TEAM_PORT, () => console.log(`fake team JWKS: ${TEAM}/cdn-cgi/access/certs`));

  const makeToken = (claims: Record<string, unknown>, sub: string): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(TEAM)
      .setAudience('local-test-aud')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  console.log('--- env for the main server ---');
  console.log('MCP_AUTH_MODE=cf-access');
  console.log(`CF_ACCESS_TEAM_DOMAIN=${TEAM}`);
  console.log('CF_ACCESS_AUD=local-test-aud');
  console.log('--- tokens ---');
  console.log(`USER_TOKEN=${await makeToken({ email: 'ada@example.com' }, 'u1')}`);
  console.log(`SERVICE_TOKEN=${await makeToken({ common_name: 'ci-bot' }, '')}`);
  console.log(`WRONG_AUD_TOKEN=${await new SignJWT({ email: 'ada@example.com' }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(TEAM).setAudience('wrong-aud').setSubject('u1').setIssuedAt().setExpirationTime('1h').sign(privateKey)}`);
}

await main();
