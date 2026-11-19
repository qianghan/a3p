import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('server-only', () => ({}));
import { encryptPii, decryptPii, PiiKeyUnconfiguredError, isPiiKeyUnconfigured } from '../agentbook-employee-pii';
import { isValidTfn, isValidSin, isValidSsn, isMaskedInput, maskEmployee } from '../agentbook-employee-profile';

const ENV = { ...process.env };
beforeEach(() => { process.env = { ...ENV }; delete process.env.EMPLOYEE_PII_ENCRYPTION_KEY; delete process.env.VERCEL_ENV; });
afterEach(() => { process.env = { ...ENV }; });

describe('employee PII encryption', () => {
  it('round-trips under a configured key; ciphertext hides the plaintext', () => {
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = '11'.repeat(32);
    const c = encryptPii('123456782');
    expect(c).not.toContain('123456782');
    expect(decryptPii(c)).toBe('123456782');
    expect(encryptPii('123456782')).not.toBe(c); // random IV
  });

  it('dev / test without a key works (bank-token pattern)', () => {
    expect(decryptPii(encryptPii('046454286'))).toBe('046454286');
  });

  it.each(['production', 'preview'])('VERCEL_ENV=%s without a key throws the typed error — no zero-key fallback', (env) => {
    process.env.VERCEL_ENV = env;
    let err: unknown;
    try { encryptPii('x'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PiiKeyUnconfiguredError);
    expect(isPiiKeyUnconfigured(err)).toBe(true);
    expect((err as PiiKeyUnconfiguredError).code).toBe('pii_key_unconfigured');
  });

  it('production: data encrypted with the dev zero key cannot be read', () => {
    const devCipher = encryptPii('secret'); // NODE_ENV=test → zero key
    process.env.VERCEL_ENV = 'production';
    expect(() => decryptPii(devCipher)).toThrow(PiiKeyUnconfiguredError);
  });

  it('a wrong-length key fails closed', () => {
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = 'abcd';
    expect(() => encryptPii('x')).toThrow(PiiKeyUnconfiguredError);
  });

  it('detects tampering (GCM auth tag)', () => {
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = '22'.repeat(32);
    const buf = Buffer.from(encryptPii('0011223344'), 'base64');
    buf[buf.length - 1] ^= 0x01;
    expect(() => decryptPii(buf.toString('base64'))).toThrow();
  });

  it('a different key cannot decrypt', () => {
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = '33'.repeat(32);
    const c = encryptPii('x1');
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = '44'.repeat(32);
    expect(() => decryptPii(c)).toThrow();
  });

  it('reads the key lazily — importing never throws in production', async () => {
    process.env.VERCEL_ENV = 'production';
    vi.resetModules();
    await expect(import('../agentbook-employee-pii')).resolves.toBeDefined();
  });
});

describe('tax-id validators', () => {
  it('TFN checksum', () => {
    expect(isValidTfn('123 456 782')).toBe(true);
    expect(isValidTfn('123456789')).toBe(false);
    expect(isValidTfn('12345')).toBe(false);
  });
  it('SIN Luhn', () => {
    expect(isValidSin('046-454-286')).toBe(true);
    expect(isValidSin('046454287')).toBe(false);
    expect(isValidSin('04645428')).toBe(false);
  });
  it('SSN rules', () => {
    expect(isValidSsn('123-45-6789')).toBe(true);
    for (const bad of ['000-12-3456', '666-12-3456', '912-12-3456', '123-00-4567', '123-45-0000', '12345']) expect(isValidSsn(bad)).toBe(false);
  });
  it('masked echoes are recognised', () => {
    expect(isMaskedInput('***-**-6789')).toBe(true);
    expect(isMaskedInput('••••6789')).toBe(true);
    expect(isMaskedInput('123-45-6789')).toBe(false);
  });
});

describe('maskEmployee', () => {
  it('drops every ciphertext column', () => {
    const out = JSON.stringify(maskEmployee({ id: 'e', sensitive: { taxIdEnc: 'CIPHER-A', bankAccountEnc: 'CIPHER-B', superMemberNumberEnc: 'CIPHER-C', taxIdLast4: '6789' } }));
    expect(out).not.toMatch(/CIPHER/);
    expect(out).toContain('"taxIdLast4":"6789"');
  });
});
