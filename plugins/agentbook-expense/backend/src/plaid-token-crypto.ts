/**
 * Plaid access-token encryption for the agentbook-expense plugin backend.
 *
 * Plaid access tokens grant indefinite read access to a customer's bank
 * account, so we encrypt them at rest with AES-256-GCM (authenticated
 * encryption — the auth tag detects any tampering at decrypt time).
 *
 * Format: base64(iv ‖ authTag ‖ ciphertext)
 *   - iv:         12 bytes (GCM standard)
 *   - authTag:    16 bytes
 *   - ciphertext: variable
 *
 * This format is intentionally identical to apps/web-next/src/lib/
 * agentbook-bank-token.ts so the legacy Express backend and the modern
 * Next.js route can both read tokens out of the same
 * `AbBankAccount.accessTokenEnc` column. Keep both files in sync if the
 * format ever changes.
 *
 * Key source: BANK_TOKEN_ENCRYPTION_KEY (32-byte hex string, 64 chars).
 * In production / preview / staging the env var is REQUIRED — we fail
 * closed rather than encrypt with a known-bad fallback key. In local dev
 * and tests we fall back to an all-zero key with a one-time warning so
 * the inner loop isn't blocked.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// 32-byte all-zero hex string. Only used when BANK_TOKEN_ENCRYPTION_KEY
// is unset and we're clearly in dev/test. Production / preview / staging
// throw instead.
const DEV_FALLBACK_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000';

let warnedAboutDevKey = false;

function isLocalOrTest(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  // VERCEL_ENV is 'production' | 'preview' | 'development' on Vercel.
  // Outside Vercel (local laptops, CI), it's typically unset.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'development') {
    return false;
  }
  return process.env.NODE_ENV !== 'production';
}

function getKey(): Buffer {
  const hex = process.env.BANK_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    if (!isLocalOrTest()) {
      throw new Error(
        'BANK_TOKEN_ENCRYPTION_KEY must be set in production, preview, and staging',
      );
    }
    if (!warnedAboutDevKey) {
      console.warn(
        '[plaid-token-crypto] BANK_TOKEN_ENCRYPTION_KEY is not set — ' +
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
  // Reject obvious garbage early so the error message is useful. Minimum
  // valid format is 12 (IV) + 16 (auth tag) + ≥1 (ciphertext) = 29 bytes
  // raw — once base64-encoded that's at least 29 characters.
  if (typeof ciphertext !== 'string' || ciphertext.length < 29) {
    throw new Error('decryptToken: ciphertext too short or missing');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new Error('decryptToken: not valid base64');
  }
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    // Buffer.from('not-base64-!@#$', 'base64') doesn't throw; it silently
    // strips invalid chars. The resulting buffer being too short is the
    // signal that the input was junk.
    throw new Error('decryptToken: ciphertext too short to be valid');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
