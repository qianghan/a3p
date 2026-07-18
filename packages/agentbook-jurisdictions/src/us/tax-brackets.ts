import type { TaxBracketProvider, TaxBracket, TaxCalculation } from '../interfaces.js';

const FEDERAL_BRACKETS_2025_SINGLE: TaxBracket[] = [
  { min: 0, max: 1160000, rate: 0.10 },
  { min: 1160000, max: 4712500, rate: 0.12 },
  { min: 4712500, max: 10052500, rate: 0.22 },
  { min: 10052500, max: 19190000, rate: 0.24 },
  { min: 19190000, max: 24337500, rate: 0.32 },
  { min: 24337500, max: 60962500, rate: 0.35 },
  { min: 60962500, max: null, rate: 0.37 },
];

// Real IRS 2025 married-filing-jointly federal brackets (Rev. Proc. 2024-40),
// in cents. NOTE: this is NOT simply 2x FEDERAL_BRACKETS_2025_SINGLE above —
// that table is itself a few years stale (closer to 2024 single-filer
// figures than true 2025 ones; see docs/superpowers/sdd/us-mfj-report.md).
// These married thresholds are taken directly from the published 2025 IRS
// MFJ schedule: $23,850 / $96,950 / $206,700 / $394,600 / $501,050 /
// $751,600 — which not coincidentally is exactly 2x the *real* 2025
// single-filer thresholds ($11,925 / $48,475 / $103,350 / $197,300 /
// $250,525) for every bracket except the top one: the 37% bracket starts at
// $751,600, not the doubled $1,252,700 (a well-known "marriage bonus" cap
// Congress did not extend to the top bracket).
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
