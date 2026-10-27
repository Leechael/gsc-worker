/**
 * cf-access authenticator tests (M2 acceptance, plan §6.5.3):
 * missing header, bad signature, wrong aud, wrong iss, expired, cookie-only,
 * plaintext-identity-header-only → all rejected; user and service-token
 * payloads → both accepted with correct clientId.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { buildCfAccessAuthenticator } from '../src/lib/mcp-auth/cf-access.js';
import type { CfAccessConfig } from '../src/lib/config.js';

const TEAM = 'https://test.cloudflareaccess.com';
const AUD = 'app-aud-tag-123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'test-key-1';
const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

const cfg: CfAccessConfig = {
  teamDomain: TEAM,
  aud: [AUD],
};

const auth = buildCfAccessAuthenticator(cfg, { jwks: { keys: [publicJwk] } });

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/mcp', { method: 'POST', headers });
}

async function sign(claims: Record<string, unknown>, opts: { aud?: string | string[]; iss?: string; exp?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setSubject(String(claims.sub ?? 'user-sub-1'))
    .setExpirationTime(opts.exp ?? now + 3600)
    .setIssuedAt(now)
    .sign(privateKey);
}

test('user token passes; clientId = email', async () => {
  const token = await sign({ email: 'ada@example.com', sub: 'u1' });
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.authInfo.clientId, 'ada@example.com');
    assert.equal(typeof out.authInfo.expiresAt, 'number');
  }
});

test('service token passes; clientId = common_name, sub empty', async () => {
  const token = await sign({ common_name: 'ci-bot-id', sub: '' });
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.authInfo.clientId, 'ci-bot-id');
});

test('missing header → 401', async () => {
  const out = await auth(req({}));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('bad signature → 401', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = await new SignJWT({ email: 'ada@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime('1h')
    .sign(other.privateKey);
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('wrong aud → 401', async () => {
  const token = await sign({ email: 'ada@example.com' }, { aud: 'other-app' });
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('wrong iss → 401', async () => {
  const token = await sign({ email: 'ada@example.com' }, { iss: 'https://evil.cloudflareaccess.com' });
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('expired → 401', async () => {
  const token = await sign({ email: 'ada@example.com' }, { exp: Math.floor(Date.now() / 1000) - 60 });
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('cookie only (CF_Authorization) → 401; we never read the cookie', async () => {
  const out = await auth(req({ cookie: 'CF_Authorization=fake' }));
  assert.equal(out.kind, 'deny');
});

test('plaintext identity header only → 401; we never trust it', async () => {
  const out = await auth(req({ 'cf-access-authenticated-user-email': 'ada@example.com' }));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') assert.equal(out.response.status, 401);
});

test('no identity claims at all → 401', async () => {
  const token = await sign({});
  const out = await auth(req({ 'cf-access-jwt-assertion': token }));
  assert.equal(out.kind, 'deny');
});

test('deny responses carry WWW-Authenticate and are global-realm Response', async () => {
  const out = await auth(req({}));
  assert.equal(out.kind, 'deny');
  if (out.kind === 'deny') {
    assert.ok(out.response instanceof Response);
    assert.match(out.response.headers.get('www-authenticate') ?? '', /^Bearer /);
  }
});
