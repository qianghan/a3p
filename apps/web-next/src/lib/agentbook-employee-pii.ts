/**
 * Employee PII encryption (PR 4b, spec §5.5). TFN / SIN / SSN, bank account
 * numbers and super member numbers are encrypted at rest with AES-256-GCM.
 *
 * Modelled on lib/agentbook-bank-token.ts with two deliberate differences:
 *
 *  1. Separate key: EMPLOYEE_PII_ENCRYPTION_KEY (32 bytes, 64 hex chars).
 *  2. The key is read LAZILY, at the moment a value is encrypted/decrypted —
 *     never at module load — so payroll routes that never touch sensitive
 *     fields keep working on a deployment where the key is not yet set. In
 *     production / preview a missing key throws PiiKeyUnconfiguredError,
 *     which routes map to 503 { code: 'pii_key_unconfigured' }. There is no
 *     zero-key fallback there. Local dev / test use a fixed dev key, exactly
 *     like the bank-token helper.
 *
 * Output format: base64(iv ‖ authTag ‖ ciphertext).
 */

import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEV_FALLBACK_KEY_HEX = '0'.repeat(64);

export const PII_KEY_UNCONFIGURED = 'pii_key_unconfigured';

export class PiiKeyUnconfiguredError extends Error {
  readonly code = PII_KEY_UNCONFIGURED;
  constructor() {
    super('EMPLOYEE_PII_ENCRYPTION_KEY must be set in production and preview environments');
    this.name = 'PiiKeyUnconfiguredError';
  }
}

function isLocalOrTest(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const vercelEnv = process.env.VERCEL_ENV;
  // A Vercel production/preview deployment is never "local", whatever NODE_ENV says.
  if (vercelEnv === 'production' || vercelEnv === 'preview') return false;
  if (nodeEnv === 'test') return true;
  return nodeEnv !== 'production' && (!vercelEnv || vercelEnv === 'development');
}

function getKey(): Buffer {
  const hex = process.env.EMPLOYEE_PII_ENCRYPTION_KEY;
  if (!hex) {
    if (!isLocalOrTest()) throw new PiiKeyUnconfiguredError();
    return Buffer.from(DEV_FALLBACK_KEY_HEX, 'hex');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    // Misconfigured is treated as unconfigured: fail closed, never encrypt with a bad key.
    throw new PiiKeyUnconfiguredError();
  }
  return buf;
}

export function encryptPii(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptPii(ciphertext: string): string {
  if (typeof ciphertext !== 'string' || ciphertext.length < 29) {
    throw new Error('decryptPii: ciphertext too short or missing');
  }
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('decryptPii: ciphertext too short to be valid');
  }
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, buf.subarray(0, IV_LENGTH));
  decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  return Buffer.concat([decipher.update(buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)), decipher.final()]).toString('utf8');
}

export function isPiiKeyUnconfigured(err: unknown): err is PiiKeyUnconfiguredError {
  return err instanceof PiiKeyUnconfiguredError;
}
