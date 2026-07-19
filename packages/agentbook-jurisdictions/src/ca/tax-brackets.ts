import type { TaxBracketProvider, TaxBracket, TaxCalculation } from '../interfaces.js';

// Canadian federal brackets for 2025 (amounts in cents)
const FEDERAL_BRACKETS_2025: TaxBracket[] = [
  { min: 0, max: 5737500, rate: 0.15 },
  { min: 5737500, max: 11475000, rate: 0.205 },
  { min: 11475000, max: 15846800, rate: 0.26 },
  { min: 15846800, max: 22170800, rate: 0.29 },
  { min: 22170800, max: null, rate: 0.33 },
];

// Provincial/territorial tax brackets, 2025 tax year, in cents. Ported
// verbatim from plugins/agentbook-tax/backend/src/tax-forms.ts's
// PROVINCIAL_BRACKETS table (already verified/sourced during CA-GATE
// remediation for the T1-form engine) — do not re-derive these figures.
const PROVINCIAL_BRACKETS: Record<string, { limit: number; rate: number }[]> = {
  ON: [
    { limit: 5114200, rate: 0.0505 },
    { limit: 10228400, rate: 0.0915 },
    { limit: 15000000, rate: 0.1116 },
    { limit: 22000000, rate: 0.1216 },
    { limit: Infinity, rate: 0.1316 },
  ],
  BC: [
    { limit: 4707400, rate: 0.0506 },
    { limit: 9414800, rate: 0.077 },
    { limit: 10805600, rate: 0.105 },
    { limit: 13108800, rate: 0.1229 },
    { limit: 22786800, rate: 0.147 },
    { limit: Infinity, rate: 0.168 },
  ],
  AB: [
    { limit: 14212200, rate: 0.10 },
    { limit: 17070600, rate: 0.12 },
    { limit: 22769200, rate: 0.13 },
    { limit: 34153800, rate: 0.14 },
    { limit: Infinity, rate: 0.15 },
  ],
  QC: [
    { limit: 5325500, rate: 0.14 },
    { limit: 10649500, rate: 0.19 },
    { limit: 12959000, rate: 0.24 },
    { limit: Infinity, rate: 0.2575 },
  ],
  MB: [
    { limit: 4700000, rate: 0.108 },
    { limit: 10000000, rate: 0.1275 },
    { limit: Infinity, rate: 0.174 },
  ],
  SK: [
    { limit: 5346300, rate: 0.105 },
    { limit: 15275000, rate: 0.125 },
    { limit: Infinity, rate: 0.145 },
  ],
  NB: [
    { limit: 5130600, rate: 0.094 },
    { limit: 10261400, rate: 0.14 },
    { limit: 19006000, rate: 0.16 },
    { limit: Infinity, rate: 0.195 },
  ],
  NS: [
    { limit: 3099500, rate: 0.0879 },
    { limit: 6199100, rate: 0.1495 },
    { limit: 9741700, rate: 0.1667 },
    { limit: 15712400, rate: 0.175 },
    { limit: Infinity, rate: 0.21 },
  ],
  PE: [
    { limit: 3332800, rate: 0.095 },
    { limit: 6465600, rate: 0.1347 },
    { limit: 10500000, rate: 0.166 },
    { limit: 14000000, rate: 0.1762 },
    { limit: Infinity, rate: 0.19 },
  ],
  NL: [
    { limit: 4419200, rate: 0.087 },
    { limit: 8838200, rate: 0.145 },
    { limit: 15779200, rate: 0.158 },
    { limit: 22091000, rate: 0.178 },
    { limit: 28221400, rate: 0.198 },
    { limit: 56442900, rate: 0.208 },
    { limit: 112885800, rate: 0.213 },
    { limit: Infinity, rate: 0.218 },
  ],
  YT: [
    { limit: 5737500, rate: 0.064 },
    { limit: 11475000, rate: 0.09 },
    { limit: 17788200, rate: 0.109 },
    { limit: 50000000, rate: 0.128 },
    { limit: Infinity, rate: 0.15 },
  ],
  NT: [
    { limit: 5196400, rate: 0.059 },
    { limit: 10393000, rate: 0.086 },
    { limit: 16896700, rate: 0.122 },
    { limit: Infinity, rate: 0.1405 },
  ],
  NU: [
    { limit: 5470700, rate: 0.04 },
    { limit: 10941300, rate: 0.07 },
    { limit: 17788100, rate: 0.09 },
    { limit: Infinity, rate: 0.115 },
  ],
};

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

// Mirrors plugins/agentbook-tax/backend/src/tax-forms.ts's calcProgressiveTax
// exactly (round the summed total ONCE at the end) — a deliberately separate
// algorithm from calculateFromBrackets's per-bracket rounding, so provincial
// totals match the already-relied-upon T1-form engine's numbers exactly.
function calcProvincialTax(
  incomeCents: number,
  brackets: { limit: number; rate: number }[],
): { taxCents: number; marginalRate: number } {
  let tax = 0;
  let prev = 0;
  let marginalRate = 0;
  for (const b of brackets) {
    if (incomeCents <= prev) break;
    const taxable = Math.min(incomeCents, b.limit) - prev;
    tax += taxable * b.rate;
    marginalRate = b.rate;
    prev = b.limit;
  }
  return { taxCents: Math.round(tax), marginalRate };
}

export const caTaxBrackets: TaxBracketProvider = {
  jurisdiction: 'ca',
  getTaxBrackets(taxYear: number) {
    return FEDERAL_BRACKETS_2025; // TODO: year-versioned lookup
  },
  calculateTax(taxableIncomeCents: number, taxYear: number, _filingStatus?: string, region?: string): TaxCalculation {
    const federal = calculateFromBrackets(taxableIncomeCents, FEDERAL_BRACKETS_2025);

    // No region (or empty string) → federal-only, unchanged from before this
    // fix. This keeps every existing 2-arg caller's behavior identical.
    if (!region) return federal;

    // Unrecognized province/territory code falls back to Ontario, mirroring
    // the existing PROVINCIAL_BRACKETS[province] || PROVINCIAL_BRACKETS['ON']
    // convention in tax-forms.ts.
    const brackets = PROVINCIAL_BRACKETS[region] ?? PROVINCIAL_BRACKETS['ON'];
    const provincial = calcProvincialTax(taxableIncomeCents, brackets);

    const totalTax = federal.taxCents + provincial.taxCents;
    return {
      taxCents: totalTax,
      effectiveRate: taxableIncomeCents > 0 ? totalTax / taxableIncomeCents : 0,
      marginalRate: federal.marginalRate + provincial.marginalRate,
      // Breakdown stays federal-only — nothing currently consumes this field
      // from a CA calculateTax() call, and combining two differently-shaped
      // bracket schedules into one breakdown list isn't worth the complexity
      // until a real consumer needs it.
      bracketBreakdown: federal.bracketBreakdown,
    };
  },
};
