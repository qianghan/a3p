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
}

export interface PayResult {
  grossCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  ficaCents: number; // SS+Medicare (US) / CPP+EI (CA) / NI (UK) / 0 (AU, super is employer-side)
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

function calcUS(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const brackets = input.filingStatus === 'married' ? US_MARRIED : US_SINGLE;
  const federalTaxCents = Math.round(progressive(annual, brackets) / input.payPeriodsPerYear);
  // FICA: 6.2% SS up to wage base + 1.45% Medicare (no cap).
  const ssAnnual = Math.min(annual, US_SS_WAGE_BASE);
  const ssCents = Math.round((ssAnnual * 0.062) / input.payPeriodsPerYear);
  const medicareCents = Math.round((input.grossCents) * 0.0145);
  const ficaCents = ssCents + medicareCents;
  const stateTaxCents = 0; // state withholding configured per-state later
  const netCents = input.grossCents - federalTaxCents - ficaCents - stateTaxCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}

// --- Canada -----------------------------------------------------------------
const CA_FED: Bracket[] = [
  { upTo: 57_375_00, rate: 0.15 }, { upTo: 114_750_00, rate: 0.205 },
  { upTo: 158_468_00, rate: 0.26 }, { upTo: 221_708_00, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
];
const CA_CPP_MAX = 3_867_50; // annual employee max
const CA_EI_MAX = 1_049_12;

function calcCA(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const federalTaxCents = Math.round(progressive(annual, CA_FED) / input.payPeriodsPerYear);
  // CPP 5.95% and EI 1.66%, each capped annually.
  const cppAnnual = Math.min(Math.round(annual * 0.0595), CA_CPP_MAX);
  const eiAnnual = Math.min(Math.round(annual * 0.0166), CA_EI_MAX);
  const ficaCents = Math.round((cppAnnual + eiAnnual) / input.payPeriodsPerYear);
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
