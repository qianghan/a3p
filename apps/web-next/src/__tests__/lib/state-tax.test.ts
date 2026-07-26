import { describe, it, expect } from 'vitest';
import { calculateStateTax, isStateModeled } from '@/lib/state-tax';

describe('calculateStateTax', () => {
  it('computes California progressive tax on $50k taxable', () => {
    // 1% to 10,756 + 2% band + 4% band + 6% band … = 157,756 cents.
    const r = calculateStateTax(5_000_000, 'CA', 'US');
    expect(r.modeled).toBe(true);
    expect(r.taxCents).toBe(157_756);
  });

  it('applies a flat rate (PA 3.07%)', () => {
    const r = calculateStateTax(10_000_000, 'PA', 'US');
    expect(r.taxCents).toBe(307_000);
  });

  it('returns $0 for a no-income-tax state (TX) and marks it modeled', () => {
    const r = calculateStateTax(10_000_000, 'TX', 'US');
    expect(r.taxCents).toBe(0);
    expect(r.modeled).toBe(true);
    expect(r.note).toMatch(/no income tax/i);
  });

  it('computes an Ontario provincial bracket on $60k', () => {
    const r = calculateStateTax(6_000_000, 'ON', 'CA');
    expect(r.modeled).toBe(true);
    expect(r.taxCents).toBe(339_318);
  });

  it('flags an unmodeled state (returns 0, modeled=false)', () => {
    const r = calculateStateTax(10_000_000, 'ZZ', 'US');
    expect(r.taxCents).toBe(0);
    expect(r.modeled).toBe(false);
    expect(r.note).toMatch(/isn't modeled/i);
  });

  it('flags a missing region (modeled=false)', () => {
    expect(calculateStateTax(10_000_000, '', 'US').modeled).toBe(false);
    expect(isStateModeled('', 'US')).toBe(false);
    expect(isStateModeled('CA', 'US')).toBe(true);
  });

  it('returns $0 (modeled) for countries with no sub-national income tax (AU)', () => {
    const r = calculateStateTax(10_000_000, 'NSW', 'AU');
    expect(r.taxCents).toBe(0);
    expect(r.modeled).toBe(true);
  });

  it('never taxes negative/zero income', () => {
    expect(calculateStateTax(0, 'CA', 'US').taxCents).toBe(0);
    expect(calculateStateTax(-500, 'CA', 'US').taxCents).toBe(0);
  });
});
