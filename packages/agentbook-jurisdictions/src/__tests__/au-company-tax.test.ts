import { describe, it, expect } from 'vitest';
import { auCompanyTaxBrackets } from '../au/company-tax.js';

describe('AU Company Tax (flat "base rate entity" rate)', () => {
  it('has jurisdiction set to "au"', () => {
    expect(auCompanyTaxBrackets.jurisdiction).toBe('au');
  });

  it('applies a flat 25% to $80,000 taxable income — no tax-free threshold, unlike individual brackets', () => {
    // $80,000 = 8,000,000 cents. Flat 25% = 2,000,000 cents ($20,000).
    // Contrast with the individual auTaxBrackets result for the same
    // income (1,478,800 cents income tax, per au-pack.test.ts) — a
    // company pays MORE tax at this income level because it has no
    // $18,200 tax-free threshold, which is real and expected, not a bug.
    const result = auCompanyTaxBrackets.calculateTax(8_000_000, 2025);
    expect(result.taxCents).toBe(2_000_000);
    expect(result.marginalRate).toBe(0.25);
    expect(result.effectiveRate).toBeCloseTo(0.25, 5);
  });

  it('flat rate is invariant of income level — no tiers, no tax-free threshold', () => {
    const low = auCompanyTaxBrackets.calculateTax(100_000, 2025); // $1,000
    const high = auCompanyTaxBrackets.calculateTax(50_000_000, 2025); // $500,000
    expect(low.marginalRate).toBe(0.25);
    expect(high.marginalRate).toBe(0.25);
    expect(low.effectiveRate).toBeCloseTo(0.25, 5);
    expect(high.effectiveRate).toBeCloseTo(0.25, 5);
  });

  it('returns zero tax and zero effective rate for zero income', () => {
    const result = auCompanyTaxBrackets.calculateTax(0, 2025);
    expect(result.taxCents).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it('rounds to the nearest cent for an odd-cent income figure', () => {
    // 333 cents × 0.25 = 83.25 → rounds to 83.
    const result = auCompanyTaxBrackets.calculateTax(333, 2025);
    expect(result.taxCents).toBe(83);
  });
});
