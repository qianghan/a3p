import type { TaxBracketProvider, TaxBracket, TaxCalculation } from '../interfaces.js';

// ATO company tax rate for a "base rate entity" (aggregated turnover under
// $50M and no more than 80% passive income) — 25% for the 2024-25 income
// year. This is the rate that applies to essentially every tenant in this
// product's target persona (freelancers/micro-SMBs under ~$1M revenue).
// The 30% full company tax rate (for entities that don't qualify as a base
// rate entity) is NOT modeled — out of scope for this persona.
const AU_COMPANY_RATE = 0.25;
const AU_COMPANY_BRACKETS: TaxBracket[] = [
  { min: 0, max: null, rate: AU_COMPANY_RATE },
];

function calculateFromBrackets(incomeCents: number, brackets: TaxBracket[]): TaxCalculation {
  let totalTax = 0;
  const breakdown: TaxCalculation['bracketBreakdown'] = [];
  for (const bracket of brackets) {
    if (incomeCents <= bracket.min) break;
    const taxable = Math.min(incomeCents, bracket.max ?? Infinity) - bracket.min;
    const tax = Math.round(taxable * bracket.rate);
    totalTax += tax;
    breakdown.push({ bracket, taxCents: tax });
  }
  return {
    taxCents: totalTax,
    effectiveRate: incomeCents > 0 ? totalTax / incomeCents : 0,
    marginalRate: incomeCents > 0 ? AU_COMPANY_RATE : 0,
    bracketBreakdown: breakdown,
  };
}

export const auCompanyTaxBrackets: TaxBracketProvider = {
  jurisdiction: 'au',
  getTaxBrackets(taxYear: number) { return AU_COMPANY_BRACKETS; },
  calculateTax(taxableIncomeCents: number, taxYear: number) {
    return calculateFromBrackets(taxableIncomeCents, AU_COMPANY_BRACKETS);
  },
};
