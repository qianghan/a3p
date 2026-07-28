/**
 * One canonical total-income-tax composer, shared by every surface that needs
 * a total tax figure (the What-If simulator on web + in chat, cash-flow
 * scenarios). It composes the same way the estimate route does:
 *
 *   self-employment tax  →  deduct the deductible half  →  federal income tax
 *   on the remainder  +  sub-national (US state / CA provincial) tax.
 *
 * The bracket provider is called WITHOUT a region so it returns FEDERAL tax
 * only; calculateStateTax is the single source of sub-national tax. That makes
 * a provincial/state double-count structurally impossible.
 */
import { usTaxBrackets } from './us/tax-brackets.js';
import { caTaxBrackets } from './ca/tax-brackets.js';
import { auTaxBrackets } from './au/tax-brackets.js';
import { usSelfEmploymentTax } from './us/self-employment-tax.js';
import { caSelfEmploymentTax } from './ca/self-employment-tax.js';
import { auSelfEmploymentTax } from './au/self-employment-tax.js';
import { calculateStateTax } from './sub-national-tax.js';
import type { TaxBracketProvider, SelfEmploymentTaxCalculator } from './interfaces.js';

const BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};
const SE_TAX_CALCULATORS: Record<string, SelfEmploymentTaxCalculator> = {
  us: usSelfEmploymentTax,
  ca: caSelfEmploymentTax,
  au: auSelfEmploymentTax,
};

export interface TotalTaxBreakdown {
  seTaxCents: number;
  incomeTaxCents: number; // federal income tax only
  stateTaxCents: number;  // sub-national: US state / CA provincial
  totalTaxCents: number;
  stateModeled: boolean;  // false → this region isn't modeled (excluded, disclose it)
}

/**
 * Total income tax (SE + federal + sub-national) on annual net income.
 * @param region state/province code — used only for sub-national tax.
 */
export function estimateTotalIncomeTax(
  netIncomeCents: number,
  jurisdiction: string,
  region: string | null | undefined,
  taxYear: number,
): TotalTaxBreakdown {
  if (netIncomeCents <= 0) {
    return { seTaxCents: 0, incomeTaxCents: 0, stateTaxCents: 0, totalTaxCents: 0, stateModeled: true };
  }
  const seCalc = SE_TAX_CALCULATORS[jurisdiction];
  const se = seCalc ? seCalc.calculate(netIncomeCents, taxYear) : { amountCents: 0, deductiblePortionCents: 0 };
  const taxable = Math.max(0, netIncomeCents - se.deductiblePortionCents);
  // Federal ONLY (no region) — sub-national comes solely from calculateStateTax.
  const incomeTaxCents = (BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets).calculateTax(taxable, taxYear).taxCents;
  const st = calculateStateTax(taxable, region, jurisdiction.toUpperCase());
  return {
    seTaxCents: se.amountCents,
    incomeTaxCents,
    stateTaxCents: st.taxCents,
    totalTaxCents: se.amountCents + incomeTaxCents + st.taxCents,
    stateModeled: st.modeled,
  };
}
