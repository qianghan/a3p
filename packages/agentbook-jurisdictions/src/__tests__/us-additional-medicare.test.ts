import { describe, expect, it } from 'vitest';
import { usSelfEmploymentTax, additionalMedicareThresholdCents } from '../us/self-employment-tax.js';

/**
 * The 0.9% Additional Medicare Tax.
 *
 * It was modelled as one more band of the Medicare rate — a flat $200,000
 * step applied to self-employment income alone, folded into the one-half
 * deduction. It is none of those things. It is a separate tax on Form 8959,
 * its threshold depends on filing status, wages consume that threshold
 * before self-employment income is tested against it, and it is excluded
 * from the deduction entirely.
 *
 * Each of the three errors moves real money, and they do not all move it in
 * the same direction — which is why "the number looked about right" never
 * caught them.
 */

const YEAR = 2026;
const ADDL = (r: { breakdown: Record<string, number> }) => r.breakdown.additional_medicare;

describe('the threshold depends on filing status', () => {
  it('is $250,000 filing jointly, not $200,000', () => {
    expect(additionalMedicareThresholdCents('married')).toBe(25_000_000);
    expect(additionalMedicareThresholdCents('married_joint')).toBe(25_000_000);
    expect(additionalMedicareThresholdCents('mfj')).toBe(25_000_000);
  });

  it('is $125,000 married filing separately', () => {
    expect(additionalMedicareThresholdCents('married_separate')).toBe(12_500_000);
    expect(additionalMedicareThresholdCents('mfs')).toBe(12_500_000);
  });

  it('falls back to $200,000 for single, head of household, and anything unknown', () => {
    // "All others" is the correct IRS line for single/HoH/qualifying surviving
    // spouse, so an unrecognised value lands on the right answer rather than
    // on a guess.
    for (const s of ['single', 'head_of_household', '', null, undefined, 'wat']) {
      expect(additionalMedicareThresholdCents(s)).toBe(20_000_000);
    }
  });

  it('over-charged a married couple by up to $450 a year', () => {
    // $300,000 net SE → taxable base $277,050.
    const single = ADDL(usSelfEmploymentTax.calculate(30_000_000, YEAR, { filingStatus: 'single' }));
    const joint = ADDL(usSelfEmploymentTax.calculate(30_000_000, YEAR, { filingStatus: 'married' }));
    expect(single).toBe(Math.round((27_705_000 - 20_000_000) * 0.009)); // $693.45
    expect(joint).toBe(Math.round((27_705_000 - 25_000_000) * 0.009));  // $243.45
    expect(single - joint).toBe(45_000); // exactly $450 — 0.9% of the $50k band
  });
});

describe('wages consume the threshold before business income is tested', () => {
  it('taxes a salaried side-hustler who used to show zero', () => {
    // $150,000 salary + $60,000 self-employment, single. Business income alone
    // is nowhere near $200,000, so the old code returned nothing at all.
    const r = usSelfEmploymentTax.calculate(6_000_000, YEAR, {
      filingStatus: 'single', medicareWagesCents: 15_000_000,
    });
    const base = Math.round(6_000_000 * 0.9235);           // 5,541,000
    const remaining = 20_000_000 - 15_000_000;             // 5,000,000
    expect(ADDL(r)).toBe(Math.round((base - remaining) * 0.009));
    expect(ADDL(r)).toBeGreaterThan(0);
    // Same income, wages ignored — what we used to report.
    expect(ADDL(usSelfEmploymentTax.calculate(6_000_000, YEAR, { filingStatus: 'single' }))).toBe(0);
  });

  it('taxes every dollar once wages have eaten the whole threshold', () => {
    const r = usSelfEmploymentTax.calculate(6_000_000, YEAR, {
      filingStatus: 'single', medicareWagesCents: 25_000_000,
    });
    expect(ADDL(r)).toBe(Math.round(Math.round(6_000_000 * 0.9235) * 0.009));
  });

  it('never lets wages push the threshold below zero', () => {
    // A negative remaining threshold would tax MORE than the whole base.
    const r = usSelfEmploymentTax.calculate(6_000_000, YEAR, {
      filingStatus: 'single', medicareWagesCents: 90_000_000,
    });
    expect(ADDL(r)).toBeLessThanOrEqual(Math.round(Math.round(6_000_000 * 0.9235) * 0.009));
  });

  it('ignores a nonsensical negative wage figure rather than crediting it', () => {
    const withNegative = ADDL(usSelfEmploymentTax.calculate(30_000_000, YEAR, {
      filingStatus: 'single', medicareWagesCents: -5_000_000,
    }));
    const without = ADDL(usSelfEmploymentTax.calculate(30_000_000, YEAR, { filingStatus: 'single' }));
    expect(withNegative).toBe(without);
  });
});

describe('the Additional Medicare Tax is not deductible', () => {
  it('excludes it from the one-half deduction', () => {
    // Form 8959, not Schedule SE. Including it overstated the deduction and
    // so understated the tax.
    const r = usSelfEmploymentTax.calculate(30_000_000, YEAR, { filingStatus: 'single' });
    const { social_security, medicare, additional_medicare } = r.breakdown;
    expect(additional_medicare).toBeGreaterThan(0);
    expect(r.deductiblePortionCents).toBe(Math.round((social_security + medicare) / 2));
    expect(r.deductiblePortionCents).not.toBe(Math.round(r.amountCents / 2));
  });

  it('still deducts exactly half below the threshold, where nothing changed', () => {
    const r = usSelfEmploymentTax.calculate(8_000_000, YEAR, { filingStatus: 'single' });
    expect(r.breakdown.additional_medicare).toBe(0);
    expect(r.deductiblePortionCents).toBe(Math.round(r.amountCents / 2));
  });
});

describe('the rest of the calculation is untouched', () => {
  it('caps Social Security and leaves Medicare uncapped', () => {
    const r = usSelfEmploymentTax.calculate(50_000_000, YEAR, { filingStatus: 'single' });
    expect(r.breakdown.social_security).toBe(Math.round(18_450_000 * 0.124));
    expect(r.breakdown.medicare).toBe(Math.round(Math.round(50_000_000 * 0.9235) * 0.029));
  });

  it('gives a below-threshold single filer the same answer as before', () => {
    // No silent change for the typical user.
    const r = usSelfEmploymentTax.calculate(10_000_000, YEAR);
    const base = Math.round(10_000_000 * 0.9235);
    expect(r.amountCents).toBe(Math.round(Math.min(base, 18_450_000) * 0.124) + Math.round(base * 0.029));
  });
});
