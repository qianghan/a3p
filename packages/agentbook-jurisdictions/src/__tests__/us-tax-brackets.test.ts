import { describe, it, expect } from 'vitest';
import { usTaxBrackets } from '../us/tax-brackets.js';
import { caTaxBrackets } from '../ca/tax-brackets.js';
import { auTaxBrackets } from '../au/tax-brackets.js';

// $150,000 is deep in the single-filer 24% bracket but still inside the
// married-filing-jointly 22% bracket for both the repo's existing (stale)
// single table and the real 2025 IRS MFJ table, so it reliably exercises the
// filingStatus branch regardless of exact bracket-edge values.
const INCOME_150K_CENTS = 15_000_000;

describe('usTaxBrackets.calculateTax filingStatus', () => {
  it('uses the married brackets and produces lower tax than single at $150,000', () => {
    const single = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'single');
    const married = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'married');

    expect(married.taxCents).toBeLessThan(single.taxCents);
    expect(single.marginalRate).toBe(0.24);
    expect(married.marginalRate).toBe(0.22);
  });

  it('matches the real 2025 IRS MFJ bracket calculation at $150,000', () => {
    // Real IRS 2025 MFJ thresholds (Rev. Proc. 2024-40): $23,850 / $96,950 /
    // $206,700 / ... Computed by hand against those brackets:
    // 10%: 2,385,000 * 0.10 = 238,500
    // 12%: (9,695,000 - 2,385,000) * 0.12 = 877,200
    // 22%: (15,000,000 - 9,695,000) * 0.22 = 1,167,100
    // total = 2,282,800 cents
    const married = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'married');
    expect(married.taxCents).toBe(2_282_800);
  });

  it('omitting filingStatus entirely still produces the single-filer result (backward compatibility)', () => {
    const withoutArg = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025);
    const withSingle = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'single');

    expect(withoutArg).toEqual(withSingle);
  });

  it('filingStatus "single" explicitly produces the single-filer result', () => {
    const result = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'single');
    expect(result.marginalRate).toBe(0.24);
  });

  it('an unrecognized filingStatus value falls back to single-filer (default-safe)', () => {
    const result = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'head_of_household');
    const single = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'single');
    expect(result).toEqual(single);
  });
});

describe('caTaxBrackets.calculateTax is unaffected by the new optional parameter', () => {
  it('produces the same result called with or without the extra arg, and matches the known baseline', () => {
    // CA has no married/single federal bracket split, so calculateTax must
    // ignore any extra argument entirely.
    const baseline = caTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025);
    const withExtraArg = caTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'married');
    expect(withExtraArg).toEqual(baseline);
    // Captured baseline for $150,000 against CA's existing 2025 federal brackets.
    expect(baseline.taxCents).toBe(2_953_313);
  });
});

describe('auTaxBrackets.calculateTax is unaffected by the new optional parameter', () => {
  it('produces the same result called with or without the extra arg, and matches the known baseline', () => {
    const baseline = auTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025);
    const withExtraArg = auTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'married');
    expect(withExtraArg).toEqual(baseline);
    // Captured baseline for $150,000 against AU's existing 2024-25 ATO brackets.
    expect(baseline.taxCents).toBe(3_683_800);
  });
});
