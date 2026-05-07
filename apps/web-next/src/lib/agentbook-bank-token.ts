/**
 * Bank-token encryption helper. Plaid access tokens grant indefinite
 * read access to a customer's bank account, so we encrypt them at rest
 * with AES-256-GCM. The key comes from BANK_TOKEN_ENCRYPTION_KEY
 * (32-byte hex). For local dev we fall back to a fixed key with a
 * one-time warning so the dev loop isn't blocked, but *production*
 * deployments must set the env var.
 *
 * Output format: base64(iv ‖ authTag ‖ ciphertext)
 *   - iv:       12 bytes (GCM standard)
 *   - authTag:  16 bytes
 *   - ciphertext: variable
 */

import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// 32-byte all-zero hex string. Only used when BANK_TOKEN_ENCRYPTION_KEY
// is unset — i.e. local dev. We warn loudly so it's obvious in logs.
const DEV_FALLBACK_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000';

let warnedAboutDevKey = false;

function getKey(): Buffer {
  const hex = process.env.BANK_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    if (!warnedAboutDevKey) {
      console.warn(
        '[agentbook-bank-token] BANK_TOKEN_ENCRYPTION_KEY is not set — ' +
          'using a dev fallback key. DO NOT USE IN PRODUCTION.',
      );
      warnedAboutDevKey = true;
    }
    return Buffer.from(DEV_FALLBACK_KEY_HEX, 'hex');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `BANK_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${buf.length} bytes`,
    );
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  // Reject obvious garbage early so the error message is useful.
  if (typeof ciphertext !== 'string' || ciphertext.length < 28) {
    throw new Error('decryptToken: ciphertext too short or missing');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new Error('decryptToken: not valid base64');
  }
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('decryptToken: ciphertext too short to be valid');
  }
  // Buffer.from('not-base64-!@#$', 'base64') doesn't throw; it silently
  // strips invalid chars. Catch the resulting too-short buffer.
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
