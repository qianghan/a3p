/**
 * Pure payroll withholding calculators, per jurisdiction. All amounts in
 * cents, all inputs/outputs explicit so the logic is deterministic and
 * unit-testable. These are reasonable 2024-ish approximations for planning —
 * not a substitute for certified payroll software at filing time.
 */

export interface PayInput {
  jurisdiction: string; // us | ca | uk | au
  grossCents: number; // gross for THIS pay period
  payPeriodsPerYear: number; // 52 | 26 | 24 | 12
  filingStatus?: string; // single | married (US)
  region?: string; // US work state (e.g. "CA") — drives state income tax withholding
}

export interface PayResult {
  grossCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number; // SS+Medicare (US) / CPP+EI (CA, or QPP+QC-EI+QPIP for Quebec) / NI (UK) / 0 (AU, super is employer-side)
  otherDeductCents: number;
  netCents: number;
  sgCents: number; // Superannuation Guarantee (AU only) — additive on top of gross, never subtracted from netCents; 0 elsewhere
}

interface Bracket { upTo: number; rate: number } // annual cents thresholds

function progressive(annualCents: number, brackets: Bracket[]): number {
  if (annualCents <= 0) return 0;
  let remaining = annualCents;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const width = b.upTo === Infinity ? remaining : b.upTo - prev;
    const taxable = Math.min(remaining, width);
    tax += Math.round(taxable * b.rate);
    remaining -= taxable;
    prev = b.upTo;
    if (remaining <= 0) break;
  }
  return tax;
}

// --- US ---------------------------------------------------------------------
const US_SINGLE: Bracket[] = [
  { upTo: 11_600_00, rate: 0.10 }, { upTo: 47_150_00, rate: 0.12 },
  { upTo: 100_525_00, rate: 0.22 }, { upTo: 191_950_00, rate: 0.24 },
  { upTo: 243_725_00, rate: 0.32 }, { upTo: 609_350_00, rate: 0.35 },
  { upTo: Infinity, rate: 0.37 },
];
const US_MARRIED: Bracket[] = [
  { upTo: 23_200_00, rate: 0.10 }, { upTo: 94_300_00, rate: 0.12 },
  { upTo: 201_050_00, rate: 0.22 }, { upTo: 383_900_00, rate: 0.24 },
  { upTo: 487_450_00, rate: 0.32 }, { upTo: 731_200_00, rate: 0.35 },
  { upTo: Infinity, rate: 0.37 },
];
const US_SS_WAGE_BASE = 168_600_00;

// Flat per-state income-tax approximation for all 50 states + DC, matching
// this file's documented precision level ("reasonable approximations for
// planning") — not progressive brackets. No-income-tax states are explicit
// 0s. For the 26 states with progressive brackets, the top marginal
// statutory rate is used as a documented over-withholding-safe
// approximation (a full per-bracket engine for every state is out of scope
// for this fix). Sourced from the Tax Foundation's 2026 state income tax
// data (https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/).
// Mirrors packages/agentbook-jurisdictions/src/us/sales-tax.ts's STATE_RATES
// table (a different tax, same per-state lookup convention).
// Exported (not just used internally) so tests can enumerate real table
// membership directly, rather than only observing calcUS's `?? 0` fallback
// output — which can't distinguish "genuinely zero" from "entry missing"
// from the outside.
export const US_STATE_INCOME_TAX_RATES: Record<string, number> = {
  // No income tax (9)
  AK: 0, FL: 0, NV: 0, NH: 0, SD: 0, TN: 0, TX: 0, WA: 0, WY: 0,
  // Flat-rate states (16)
  AZ: 0.0250, CO: 0.0440, GA: 0.0499, ID: 0.0530, IL: 0.0495, IN: 0.0295, IA: 0.0380, KY: 0.0350,
  LA: 0.0300, MI: 0.0425, MS: 0.0400, MO: 0.0470, NC: 0.0399, OH: 0.0275, PA: 0.0307, UT: 0.0445,
  // Progressive-bracket states — top marginal rate used as approximation (26)
  AL: 0.0500, AR: 0.0390, CA: 0.1330, CT: 0.0699, DE: 0.0660, HI: 0.1100, KS: 0.0558, ME: 0.0715,
  MD: 0.0650, MA: 0.0900, MN: 0.0985, MT: 0.0565, NE: 0.0455, NJ: 0.1075, NM: 0.0590, NY: 0.1090,
  ND: 0.0250, OK: 0.0450, OR: 0.0990, RI: 0.0599, SC: 0.0600, VT: 0.0875, VA: 0.0575, WV: 0.0482,
  WI: 0.0765, DC: 0.1075,
};

function calcUS(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const brackets = input.filingStatus === 'married' ? US_MARRIED : US_SINGLE;
  const federalTaxCents = Math.round(progressive(annual, brackets) / input.payPeriodsPerYear);
  // FICA: 6.2% SS up to wage base + 1.45% Medicare (no cap).
  const ssAnnual = Math.min(annual, US_SS_WAGE_BASE);
  const ssCents = Math.round((ssAnnual * 0.062) / input.payPeriodsPerYear);
  const medicareCents = Math.round((input.grossCents) * 0.0145);
  const ficaCents = ssCents + medicareCents;
  const stateRate = US_STATE_INCOME_TAX_RATES[(input.region || '').toUpperCase()] ?? 0;
  const stateTaxCents = Math.round(input.grossCents * stateRate);
  const netCents = input.grossCents - federalTaxCents - ficaCents - stateTaxCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}

// --- Canada -----------------------------------------------------------------
const CA_FED: Bracket[] = [
  { upTo: 57_375_00, rate: 0.15 }, { upTo: 114_750_00, rate: 0.205 },
  { upTo: 158_468_00, rate: 0.26 }, { upTo: 221_708_00, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
];
const CA_CPP_MAX = 3_867_50; // annual employee max (rest-of-Canada CPP)
const CA_EI_MAX = 1_049_12; // annual employee max (rest-of-Canada EI, 1.66%)
// Quebec-specific 2025 rates, real figures sourced from Revenu Québec /
// Canada.ca (see this PR's plan doc for citations): QPP's employee rate is
// higher than CPP's (6.40% vs 5.95%); Quebec's EI rate is LOWER than the
// rest of Canada's (1.31% vs 1.66%) because Quebec's own QPIP program
// covers parental/maternity benefits that EI covers everywhere else; QPIP
// itself (0.494%) doesn't exist outside Quebec. All three are flat-rate +
// annual-cap approximations, matching this file's existing CPP/EI/FICA/NI
// precision level.
const QC_QPP_RATE = 0.0640;
const QC_QPP_MAX = 4_339_20;
const QC_EI_RATE = 0.0131;
const QC_EI_MAX = 860_67;
const QC_QPIP_RATE = 0.00494;
const QC_QPIP_MAX = 484_12;

/**
 * Splits the combined CPP/QPP+EI(+QPIP) deduction back into its real,
 * separately-reportable components, given an EMPLOYEE'S AGGREGATED ANNUAL
 * gross for the year (not a single pay period). Used both by calcCA (which
 * needs the per-period combined total) and by year-end-forms.ts (which
 * needs the real CRA box-numbered annual totals — CA-3 remediation: T4
 * slips previously only had one combined, non-CRA "ficaWithheldCents" key).
 */
export function splitCaDeductions(annualGrossCents: number, region?: string): {
  pensionCents: number;
  pensionBoxLabel: 'CPP' | 'QPP';
  eiCents: number;
  qpipCents: number;
} {
  const isQuebec = (region || '').toUpperCase() === 'QC';
  if (isQuebec) {
    return {
      pensionCents: Math.min(Math.round(annualGrossCents * QC_QPP_RATE), QC_QPP_MAX),
      pensionBoxLabel: 'QPP',
      eiCents: Math.min(Math.round(annualGrossCents * QC_EI_RATE), QC_EI_MAX),
      qpipCents: Math.min(Math.round(annualGrossCents * QC_QPIP_RATE), QC_QPIP_MAX),
    };
  }
  return {
    pensionCents: Math.min(Math.round(annualGrossCents * 0.0595), CA_CPP_MAX),
    pensionBoxLabel: 'CPP',
    eiCents: Math.min(Math.round(annualGrossCents * 0.0166), CA_EI_MAX),
    qpipCents: 0,
  };
}

function calcCA(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const federalTaxCents = Math.round(progressive(annual, CA_FED) / input.payPeriodsPerYear);
  const split = splitCaDeductions(annual, input.region);
  const ficaCents = Math.round((split.pensionCents + split.eiCents + split.qpipCents) / input.payPeriodsPerYear);
  const netCents = input.grossCents - federalTaxCents - ficaCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents: 0, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}

// --- UK ---------------------------------------------------------------------
// PAYE: £12,570 personal allowance, then 20/40/45%. NI: 8% over ~£12,570.
const GBP = (n: number) => Math.round(n * 100);
const UK_PA = GBP(12570);
const UK_BANDS: Bracket[] = [
  { upTo: UK_PA, rate: 0 }, { upTo: GBP(50270), rate: 0.20 },
  { upTo: GBP(125140), rate: 0.40 }, { upTo: Infinity, rate: 0.45 },
];

function calcUK(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const federalTaxCents = Math.round(progressive(annual, UK_BANDS) / input.payPeriodsPerYear);
  const niAnnual = annual > UK_PA ? Math.round((annual - UK_PA) * 0.08) : 0;
  const ficaCents = Math.round(niAnnual / input.payPeriodsPerYear);
  const netCents = input.grossCents - federalTaxCents - ficaCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents: 0, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}

// --- Australia --------------------------------------------------------------
// PAYG: $18,200 tax-free, then 16/30/37/45%. Superannuation Guarantee (12% as
// of 1 July 2025) is employer-side — paid on top of gross, never withheld
// from net pay, so ficaCents stays 0 here (see sgCents instead).
const AUD = (n: number) => Math.round(n * 100);
const AU_BANDS: Bracket[] = [
  { upTo: AUD(18200), rate: 0 }, { upTo: AUD(45000), rate: 0.16 },
  { upTo: AUD(135000), rate: 0.30 }, { upTo: AUD(190000), rate: 0.37 },
  { upTo: Infinity, rate: 0.45 },
];
const AU_SG_RATE = 0.12;

function calcAU(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const federalTaxCents = Math.round(progressive(annual, AU_BANDS) / input.payPeriodsPerYear);
  const netCents = input.grossCents - federalTaxCents;
  // Ordinary Time Earnings (the SG base) isn't tracked separately from gross
  // pay in this simplified engine (no overtime/allowance breakdown), so gross
  // is used as the OTE proxy — a reasonable approximation for a salaried/hourly
  // employee with no overtime.
  const sgCents = Math.round(input.grossCents * AU_SG_RATE);
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents: 0, ficaCents: 0, otherDeductCents: 0, netCents, sgCents };
}

export function calcPay(input: PayInput): PayResult {
  switch (input.jurisdiction) {
    case 'ca': return calcCA(input);
    case 'uk': return calcUK(input);
    case 'au': return calcAU(input);
    default: return calcUS(input);
  }
}

export const PERIODS_PER_YEAR: Record<string, number> = {
  weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12,
};

/** Gross for one pay period given an annual salary and frequency. */
export function periodGross(annualSalaryCents: number, payFrequency: string): number {
  const periods = PERIODS_PER_YEAR[payFrequency] ?? 26;
  return Math.round(annualSalaryCents / periods);
}
