import { describe, it, expect, vi } from 'vitest';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';

/**
 * computeFilingTotals' `taxPayableCents` is the figure a user is shown on
 * the approve-my-filing screen, right before they submit. It must be the
 * jurisdiction's TOTAL tax, not an income-tax-only subtotal.
 *
 * It originally came straight from `provider.calculateTax()`, which:
 *   • for US is federal income tax only — it excludes self-employment tax,
 *     which for a sole proprietor is thousands of dollars;
 *   • for AU excludes the 2% Medicare levy, while the AU review prompt
 *     tells the LLM the figure already includes the levy.
 *
 * Both jurisdictions' own form templates already compute the real total
 * (`1040.total_tax_24 = federal_tax_16 + se_tax`,
 * `IndividualReturn.total_tax_payable = income_tax + medicare_levy`), and
 * CA's `T1.total_tax_43500` chain has always included provincial tax and
 * CPP. The right number already exists in the filing — read it.
 */

vi.mock('../db/client.js', () => ({ db: {} }));

describe('computeFilingTotals — taxPayableCents is the jurisdiction\'s TOTAL tax', () => {
  it('US: includes self-employment tax, not just federal income tax', async () => {
    const { computeFilingTotals } = await import('../tax-review-agent.js');
    const forms = {
      ScheduleC: { net_profit_31: 9000000 },
      '1040': {
        total_income_9: 9000000,
        taxable_income: 8000000,
        federal_tax_16: 1300000,
        se_tax: 1271700,
        total_tax_24: 2571700, // federal_tax_16 + se_tax
      },
    };

    const totals = computeFilingTotals('us', 'CA', 2025, forms);

    expect(totals.taxPayableCents).toBe(2571700);
    // And specifically NOT the income-tax-only figure the bracket
    // calculator alone produces.
    const incomeTaxOnly = usTaxBrackets.calculateTax(8000000, 2025, undefined, 'CA').taxCents;
    expect(totals.taxPayableCents).not.toBe(incomeTaxOnly);
    expect(totals.taxPayableCents!).toBeGreaterThan(incomeTaxOnly);
  });

  it('AU: includes the 2% Medicare levy the review prompt promises', async () => {
    const { computeFilingTotals } = await import('../tax-review-agent.js');
    // income_tax is the real PROGRESSIVE_TAX(taxable_income, au_flat) value
    // for $90,000, so this fixture matches what populateFiling would store.
    const incomeTax = auTaxBrackets.calculateTax(9000000, 2025, undefined, 'NSW').taxCents;
    const medicareLevy = 180000; // 2% of 90,000
    const forms = {
      BusinessSchedule: { net_business_income: 9000000 },
      IndividualReturn: {
        taxable_income: 9000000,
        income_tax: incomeTax,
        medicare_levy: medicareLevy,
        total_tax_payable: incomeTax + medicareLevy,
      },
    };

    const totals = computeFilingTotals('au', 'NSW', 2025, forms);

    expect(totals.taxPayableCents).toBe(incomeTax + medicareLevy);
    // The levy is real money the old code silently dropped.
    expect(totals.taxPayableCents!).toBeGreaterThan(incomeTax);
  });

  it('CA: uses the T1 total-payable line (federal + provincial + CPP), unchanged in composition', async () => {
    const { computeFilingTotals } = await import('../tax-review-agent.js');
    const forms = {
      T1: {
        total_income_15000: 7300000,
        taxable_income_26000: 7300000,
        federal_tax_40400: 900000,
        provincial_tax_42800: 450000,
        cpp_self_22200: 400000,
        total_tax_43500: 1750000,
      },
    };

    const totals = computeFilingTotals('ca', 'ON', 2025, forms);

    expect(totals.totalIncomeCents).toBe(7300000);
    expect(totals.taxableIncomeCents).toBe(7300000);
    expect(totals.taxPayableCents).toBe(1750000);
  });

  it('leaves taxPayableCents undefined rather than showing a figure it cannot vouch for', async () => {
    // A filing whose calculated fields have not been populated yet. Showing
    // an income-tax-only number here — labelled "tax payable (including
    // Medicare Levy)" for AU — would be a wrong money figure. "Not
    // available" is honest; the deterministic fallback summary says so.
    const { computeFilingTotals } = await import('../tax-review-agent.js');
    const totals = computeFilingTotals('au', 'NSW', 2025, {
      IndividualReturn: { taxable_income: 9000000 },
    });
    expect(totals.taxableIncomeCents).toBe(9000000);
    expect(totals.taxPayableCents).toBeUndefined();
  });

  it('an unknown jurisdiction yields no totals rather than a guess', async () => {
    const { computeFilingTotals } = await import('../tax-review-agent.js');
    expect(computeFilingTotals('nz', '', 2025, { Whatever: { x: 1 } })).toEqual({
      totalIncomeCents: undefined,
      taxableIncomeCents: undefined,
      taxPayableCents: undefined,
    });
  });
});
