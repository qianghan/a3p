/**
 * Unit tests for the plaid-token-crypto helper.
 *
 * Plaid access tokens are high-value credentials, so we test all the
 * failure modes that would let a corrupted token through:
 *   - round-trip (correctness)
 *   - random-IV-per-call (no deterministic ciphertext)
 *   - malformed-input rejection
 *   - tampered-ciphertext rejection (auth tag verifies)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { encryptToken, decryptToken } from '../plaid-token-crypto';

describe('plaid-token-crypto', () => {
  beforeEach(() => {
    // 32-byte hex key. Deterministic so tests are reproducible.
    process.env.BANK_TOKEN_ENCRYPTION_KEY =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  });

  it('round-trips a typical Plaid access token', () => {
    const token = 'access-sandbox-12345678-aaaa-bbbb-cccc-1234567890ab';
    const enc = encryptToken(token);
    expect(enc).not.toBe(token);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
  });

  it('produces different ciphertext for the same plaintext on each call (IV randomness)', () => {
    const token = 'access-sandbox-same-input';
    const a = encryptToken(token);
    const b = encryptToken(token);
    expect(a).not.toBe(b);
    // Both still decrypt to the same plaintext.
    expect(decryptToken(a)).toBe(token);
    expect(decryptToken(b)).toBe(token);
  });

  it('rejects malformed input', () => {
    expect(() => decryptToken('')).toThrow();
    expect(() => decryptToken('short')).toThrow();
    // Buffer.from('not-base64-!@#$', 'base64') silently strips invalid
    // chars; the resulting buffer is too short to be a valid envelope,
    // so we still reject it.
    expect(() => decryptToken('not-base64-!@#$')).toThrow();
  });

  it('rejects tampered ciphertext (auth tag verification)', () => {
    const enc = encryptToken('original-token');
    // Flip a byte in the middle of the ciphertext region (past the IV +
    // auth tag). The GCM auth tag won't verify and decryption must throw.
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });
});
