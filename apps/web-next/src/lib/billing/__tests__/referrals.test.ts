import { describe, it, expect } from 'vitest';
import { generateCode, computeReward, maskEmail, MONTHS_CAP } from '../referrals';

describe('referral code generation', () => {
  it('produces XXXX-XXXX from the unambiguous charset', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      // no ambiguous characters
      expect(code).not.toMatch(/[O0I1L]/);
    }
  });

  it('is effectively unique across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCode());
    expect(seen.size).toBeGreaterThan(990); // ~no collisions in 1000 draws
  });
});

describe('computeReward (12-month cap)', () => {
  it('grants 1 month while under the cap', () => {
    expect(computeReward(0)).toBe(1);
    expect(computeReward(11)).toBe(1);
  });
  it('grants 0 once the cap is reached', () => {
    expect(computeReward(MONTHS_CAP)).toBe(0);
    expect(computeReward(MONTHS_CAP + 5)).toBe(0);
  });
});

describe('maskEmail', () => {
  it('masks the local part, keeps the domain', () => {
    expect(maskEmail('maya@example.com')).toBe('m***@example.com');
    expect(maskEmail('a@x.io')).toBe('a*@x.io');
  });
  it('handles null / malformed', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('nodomain')).toBe('***');
  });
});
