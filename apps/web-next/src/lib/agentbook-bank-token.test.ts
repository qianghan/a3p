/**
 * Unit tests for the bank-token encryption helper. Plaid access tokens
 * are sensitive credentials, so we test round-trip + reject-bad-ciphertext
 * to make sure failures surface loudly rather than silently corrupting data.
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { encryptToken, decryptToken } from './agentbook-bank-token';

describe('agentbook-bank-token', () => {
  it('round-trips a Plaid-shaped access token', () => {
    const plaintext = 'access-sandbox-12345678-aaaa-bbbb-cccc-1234567890ab';
    const ct = encryptToken(plaintext);
    expect(ct).not.toBe(plaintext);
    expect(ct.length).toBeGreaterThan(plaintext.length);
    const back = decryptToken(ct);
    expect(back).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'access-sandbox-deadbeef';
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it('rejects malformed ciphertext', () => {
    expect(() => decryptToken('not-base64-!@#$')).toThrow();
  });

  it('rejects truncated ciphertext', () => {
    const ct = encryptToken('hello-token');
    const truncated = ct.slice(0, 5);
    expect(() => decryptToken(truncated)).toThrow();
  });

  it('rejects tampered ciphertext (GCM auth tag should fail)', () => {
    const ct = encryptToken('hello-token');
    // Flip a character in the middle of the base64 string.
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 5] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('handles unicode and longer payloads', () => {
    const plaintext = 'token-' + 'x'.repeat(500) + '-✓';
    expect(decryptToken(encryptToken(plaintext))).toBe(plaintext);
  });
});
