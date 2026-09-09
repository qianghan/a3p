import type { SelfEmploymentTaxCalculator, SelfEmploymentTaxContext, SelfEmploymentTaxResult } from '../interfaces.js';

/**
 * US self-employment tax — Social Security, Medicare, and the 0.9%
 * Additional Medicare Tax.
 *
 * The Additional Medicare Tax was wrong in three ways at once, all of them
 * money, and all of them because it was treated as just another band of the
 * Medicare rate rather than as the separate tax it is (Form 8959, not
 * Schedule SE):
 *
 *   1. The threshold was hardcoded at $200,000 for everyone. It is $250,000
 *      filing jointly and $125,000 married filing separately — so a married
 *      couple was over-charged by up to $450 a year, on tax they do not owe.
 *   2. Wages were ignored. The threshold is reduced by Medicare wages BEFORE
 *      self-employment income is tested against it, so someone with a salary
 *      and a side business crosses it far sooner than their business income
 *      alone suggests. At $250,000 of wages the threshold is gone entirely
 *      and the first dollar of self-employment income is taxable; we were
 *      reporting zero.
 *   3. It was fed into the deduction. Only one-half of the SE tax proper is
 *      deductible; the Additional Medicare Tax is not part of it.
 */

// 92.35% of net SE income is subject to SE tax (the employer-equivalent half
// of FICA is excluded from the base).
const SE_BASE_RATE = 0.9235;

const SS_RATE = 0.124;
const SS_WAGE_CAP_CENTS = 18_450_000; // $184,500 (2026)
const MEDICARE_RATE = 0.029;          // uncapped

const ADDITIONAL_MEDICARE_RATE = 0.009;
/** Filing-status thresholds for the Additional Medicare Tax. */
const ADDL_MEDICARE_THRESHOLD_CENTS = {
  married_joint: 25_000_000,     // $250,000
  married_separate: 12_500_000,  // $125,000
  other: 20_000_000,             // $200,000 — single, HoH, qualifying surviving spouse
} as const;

/**
 * Map whatever filing status the tenant has stored onto a threshold.
 *
 * `'married'` is the value this codebase actually stores and the one the
 * federal bracket table treats as filing jointly, so it maps to the joint
 * threshold. Separate-filing spellings are recognised for completeness even
 * though nothing writes them yet. Anything unrecognised takes the $200,000
 * "all others" line, which is the correct answer for single, head of
 * household and qualifying surviving spouse alike.
 */
export function additionalMedicareThresholdCents(filingStatus?: string | null): number {
  const s = (filingStatus || '').trim().toLowerCase();
  if (s === 'married' || s === 'married_joint' || s === 'mfj') {
    return ADDL_MEDICARE_THRESHOLD_CENTS.married_joint;
  }
  if (s === 'married_separate' || s === 'married_filing_separately' || s === 'mfs') {
    return ADDL_MEDICARE_THRESHOLD_CENTS.married_separate;
  }
  return ADDL_MEDICARE_THRESHOLD_CENTS.other;
}

export const usSelfEmploymentTax: SelfEmploymentTaxCalculator = {
  calculate(netSEIncomeCents: number, taxYear: number, context?: SelfEmploymentTaxContext): SelfEmploymentTaxResult {
    const taxableBase = Math.round(netSEIncomeCents * SE_BASE_RATE);

    const ssBase = Math.min(taxableBase, SS_WAGE_CAP_CENTS);
    const ssTax = Math.round(ssBase * SS_RATE);

    const medicareTax = Math.round(taxableBase * MEDICARE_RATE);

    // Additional Medicare Tax. Wages consume the threshold first (Form 8959
    // reduces it by Medicare wages, but not below zero), then self-employment
    // income is tested against whatever is left.
    const threshold = additionalMedicareThresholdCents(context?.filingStatus);
    const wages = Math.max(0, context?.medicareWagesCents ?? 0);
    const remainingThreshold = Math.max(0, threshold - wages);
    const additionalMedicare = taxableBase > remainingThreshold
      ? Math.round((taxableBase - remainingThreshold) * ADDITIONAL_MEDICARE_RATE)
      : 0;

    const totalSE = ssTax + medicareTax + additionalMedicare;

    return {
      amountCents: totalSE,
      // Half of the SE tax PROPER. The Additional Medicare Tax is computed on
      // Form 8959, not Schedule SE, and is excluded from the one-half
      // deduction — including it overstated the deduction and so understated
      // the tax.
      deductiblePortionCents: Math.round((ssTax + medicareTax) / 2),
      breakdown: {
        social_security: ssTax,
        medicare: medicareTax,
        additional_medicare: additionalMedicare,
      },
    };
  },
};
