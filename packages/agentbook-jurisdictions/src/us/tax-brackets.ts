import type { TaxBracketProvider, TaxBracket, TaxCalculation } from '../interfaces.js';

// Real IRS 2025 single-filer federal brackets (Rev. Proc. 2024-40), in
// cents: $11,925 / $48,475 / $103,350 / $197,300 / $250,525 / $626,350.
// (A previous version of this table held ~2024 single-filer figures
// mislabeled 2025 — see docs/superpowers/plans/2026-07-18-us-single-bracket-2025-fix.md
// for the US-GATE finding that caught this and the corrected sourcing.)
const FEDERAL_BRACKETS_2025_SINGLE: TaxBracket[] = [
  { min: 0, max: 1192500, rate: 0.10 },
  { min: 1192500, max: 4847500, rate: 0.12 },
  { min: 4847500, max: 10335000, rate: 0.22 },
  { min: 10335000, max: 19730000, rate: 0.24 },
  { min: 19730000, max: 25052500, rate: 0.32 },
  { min: 25052500, max: 62635000, rate: 0.35 },
  { min: 62635000, max: null, rate: 0.37 },
];

// Real IRS 2025 married-filing-jointly federal brackets (Rev. Proc. 2024-40),
// in cents: $23,850 / $96,950 / $206,700 / $394,600 / $501,050 / $751,600 —
// which is exactly 2x FEDERAL_BRACKETS_2025_SINGLE above for every bracket
// except the top one: the 37% bracket starts at $751,600, not the doubled
// $1,252,700 (a well-known "marriage bonus" cap Congress did not extend to
// the top bracket).
const FEDERAL_BRACKETS_2025_MARRIED: TaxBracket[] = [
  { min: 0, max: 2385000, rate: 0.10 },
  { min: 2385000, max: 9695000, rate: 0.12 },
  { min: 9695000, max: 20670000, rate: 0.22 },
  { min: 20670000, max: 39460000, rate: 0.24 },
  { min: 39460000, max: 50105000, rate: 0.32 },
  { min: 50105000, max: 75160000, rate: 0.35 },
  { min: 75160000, max: null, rate: 0.37 },
];

function bracketsFor(filingStatus?: string): TaxBracket[] {
  return filingStatus === 'married' ? FEDERAL_BRACKETS_2025_MARRIED : FEDERAL_BRACKETS_2025_SINGLE;
}

function calculateFromBrackets(incomeCents: number, brackets: TaxBracket[]): TaxCalculation {
  let totalTax = 0;
  const breakdown: TaxCalculation['bracketBreakdown'] = [];

  for (const bracket of brackets) {
    if (incomeCents <= bracket.min) break;
    const taxableInBracket = Math.min(incomeCents, bracket.max ?? Infinity) - bracket.min;
    const tax = Math.round(taxableInBracket * bracket.rate);
    totalTax += tax;
    breakdown.push({ bracket, taxCents: tax });
  }

  return {
    taxCents: totalTax,
    effectiveRate: incomeCents > 0 ? totalTax / incomeCents : 0,
    marginalRate: brackets.find(b => incomeCents <= (b.max ?? Infinity) && incomeCents > b.min)?.rate ?? 0,
    bracketBreakdown: breakdown,
  };
}

export const usTaxBrackets: TaxBracketProvider = {
  jurisdiction: 'us',
  getTaxBrackets(taxYear: number) {
    return FEDERAL_BRACKETS_2025_SINGLE; // TODO: year-versioned lookup
  },
  calculateTax(taxableIncomeCents: number, taxYear: number, filingStatus?: string) {
    return calculateFromBrackets(taxableIncomeCents, bracketsFor(filingStatus));
  },
};
