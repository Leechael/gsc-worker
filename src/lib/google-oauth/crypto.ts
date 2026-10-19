/**
 * WebCrypto helpers for the in-Worker Google authorization flow: AES-256-GCM
 * encryption at rest, base64url, and PKCE/state generation. Uses only the
 * `crypto` global, so it runs unchanged on workerd and Node.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const CIPHERTEXT_VERSION = 'v1';

/** WebCrypto key type without depending on DOM or Node lib typings. */
export type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64 or base64url, padded or not. Throws on malformed input. */
export function base64Decode(input: string): Uint8Array {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('not base64');
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Decode TOKEN_ENCRYPTION_KEY: base64/base64url of exactly 32 random bytes
 * (`openssl rand -base64 32`). Returns an error message instead of throwing so
 * config validation can report it.
 */
export function parseEncryptionKey(raw: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(raw);
  } catch {
    return { ok: false, error: 'TOKEN_ENCRYPTION_KEY is not valid base64. Generate one with: openssl rand -base64 32' };
  }
  if (bytes.length !== KEY_BYTES) {
    return {
      ok: false,
      error: `TOKEN_ENCRYPTION_KEY decodes to ${bytes.length} bytes; exactly ${KEY_BYTES} are required. Generate one with: openssl rand -base64 32`,
    };
  }
  return { ok: true, bytes };
}

export async function importEncryptionKey(raw: string): Promise<AesKey> {
  const parsed = parseEncryptionKey(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return crypto.subtle.importKey('raw', parsed.bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * AES-256-GCM with a fresh 96-bit IV per message. `aad` binds the ciphertext
 * to its purpose so a value cannot be swapped into another KV key.
 * Output: `v1.<iv>.<ciphertext+tag>` (base64url parts).
 */
export async function encryptString(key: AesKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${CIPHERTEXT_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(key: AesKey, blob: string, aad: string): Promise<string> {
  const [version, ivPart, ctPart, ...extra] = blob.split('.');
  if (version !== CIPHERTEXT_VERSION || !ivPart || !ctPart || extra.length > 0) {
    throw new Error('unrecognized ciphertext format');
  }
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64Decode(ivPart), additionalData: new TextEncoder().encode(aad) },
    key,
    base64Decode(ctPart),
  );
  return new TextDecoder().decode(pt);
}

/** RFC 7636 S256 code challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
