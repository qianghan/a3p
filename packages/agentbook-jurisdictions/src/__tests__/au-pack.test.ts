import { describe, it, expect } from 'vitest';
import { auTaxBrackets } from '../au/tax-brackets.js';
import { auSelfEmploymentTax } from '../au/self-employment-tax.js';
import { auSalesTax } from '../au/sales-tax.js';
import { auChartOfAccounts } from '../au/chart-of-accounts.js';
import { auInstallmentSchedule } from '../au/installment-schedule.js';
import { auContractorReport } from '../au/contractor-report.js';
import { auMileageRate } from '../au/mileage-rate.js';
import { auDeductions } from '../au/deductions.js';
import { auCalendarDeadlines } from '../au/calendar-deadlines.js';

describe('AU Tax Brackets', () => {
  it('has jurisdiction set to "au"', () => {
    expect(auTaxBrackets.jurisdiction).toBe('au');
  });

  it('calculates correct tax on $80,000 income (2024-25 Stage 3 brackets)', () => {
    // $80,000 = 8,000,000 cents
    // $0-$18,200: nil
    // $18,201-$45,000 (2,680,000 cents) @ 16% = 428,800
    // $45,001-$80,000 (3,500,000 cents) @ 30% = 1,050,000
    const result = auTaxBrackets.calculateTax(8000000, 2025);
    expect(result.bracketBreakdown[0].taxCents).toBe(0);
    expect(result.bracketBreakdown[1].taxCents).toBe(428800);
    expect(result.bracketBreakdown[2].taxCents).toBe(1050000);
    expect(result.taxCents).toBe(0 + 428800 + 1050000);
  });

  it('returns 30% marginal rate for $80,000 income', () => {
    const result = auTaxBrackets.calculateTax(8000000, 2025);
    expect(result.marginalRate).toBe(0.30);
  });

  it('returns 45% marginal rate and correct total for $200,000 income (top bracket)', () => {
    // $190,001+ @ 45%; $135,001-$190,000 (5,500,000) @ 37% = 2,035,000; $45,001-$135,000 (9,000,000) @ 30% = 2,700,000
    // $18,201-$45,000 (2,680,000) @ 16% = 428,800; top slice (1,000,000) @ 45% = 450,000
    const result = auTaxBrackets.calculateTax(20000000, 2025);
    expect(result.marginalRate).toBe(0.45);
    expect(result.taxCents).toBe(428800 + 2700000 + 2035000 + 450000);
  });

  it('returns zero tax and zero effective rate for zero income', () => {
    const result = auTaxBrackets.calculateTax(0, 2025);
    expect(result.taxCents).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it('returns nil tax for income entirely within the tax-free threshold', () => {
    const result = auTaxBrackets.calculateTax(1000000, 2025); // $10,000
    expect(result.taxCents).toBe(0);
    expect(result.marginalRate).toBe(0);
  });
});

describe('AU Self-Employment Tax (Medicare Levy)', () => {
  it('charges the full 2% above the shading-out threshold ($32,500)', () => {
    const result = auSelfEmploymentTax.calculate(5000000, 2025); // $50,000
    expect(result.amountCents).toBe(Math.round(5000000 * 0.02));
    expect(result.breakdown.medicare_levy).toBe(result.amountCents);
  });

  it('charges the shading-in rate (10% of excess over $26,000) between the two thresholds', () => {
    const result = auSelfEmploymentTax.calculate(3000000, 2025); // $30,000
    expect(result.amountCents).toBe(Math.round((3000000 - 2600000) * 0.10));
  });

  it('charges nothing below the low-income threshold ($26,000)', () => {
    const result = auSelfEmploymentTax.calculate(2000000, 2025); // $20,000
    expect(result.amountCents).toBe(0);
  });

  it('the Medicare levy is never deductible', () => {
    const result = auSelfEmploymentTax.calculate(5000000, 2025);
    expect(result.deductiblePortionCents).toBe(0);
  });
});

describe('AU Sales Tax (GST)', () => {
  it('returns a flat 10% GST rate for the standard category', () => {
    const rates = auSalesTax.getRates('standard');
    expect(rates).toHaveLength(1);
    expect(rates[0].taxType).toBe('GST');
    expect(rates[0].rate).toBe(0.10);
  });

  it('returns 0% for GST-free items', () => {
    const rates = auSalesTax.getRates('gst-free');
    expect(rates[0].rate).toBe(0);
  });

  it('returns 0% for input-taxed items', () => {
    const rates = auSalesTax.getRates('input-taxed');
    expect(rates[0].rate).toBe(0);
  });

  it('handles case-insensitive category names', () => {
    const rates = auSalesTax.getRates('STANDARD');
    expect(rates[0].rate).toBe(0.10);
  });

  it('calculates GST on $100 correctly', () => {
    const result = auSalesTax.calculateTax(10000, 'standard');
    expect(result.totalRate).toBe(0.10);
    expect(result.totalCents).toBe(1000);
  });

  it('returns 4 quarterly BAS deadlines matching real ATO dates', () => {
    const deadlines = auSalesTax.getFilingDeadlines('standard', 2025);
    expect(deadlines).toHaveLength(4);
    expect(deadlines[0].getMonth()).toBe(9);  // October
    expect(deadlines[1].getMonth()).toBe(1);  // February
    expect(deadlines[2].getMonth()).toBe(3);  // April
    expect(deadlines[3].getMonth()).toBe(6);  // July
  });
});

describe('AU Chart of Accounts', () => {
  it('returns a non-empty set of BAS-aligned accounts', () => {
    const accounts = auChartOfAccounts.getDefaultAccounts('sole_trader');
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('has all account types', () => {
    const accounts = auChartOfAccounts.getDefaultAccounts('sole_trader');
    const types = new Set(accounts.map((a) => a.type));
    expect(types).toContain('asset');
    expect(types).toContain('liability');
    expect(types).toContain('equity');
    expect(types).toContain('revenue');
    expect(types).toContain('expense');
  });

  it('includes a GST Payable liability account (not "Sales Tax Payable")', () => {
    const accounts = auChartOfAccounts.getDefaultAccounts('sole_trader');
    const gstAccount = accounts.find((a) => a.name === 'GST Payable');
    expect(gstAccount).toBeDefined();
    expect(gstAccount!.type).toBe('liability');
  });

  it('includes Superannuation Payable and Superannuation expense accounts', () => {
    const accounts = auChartOfAccounts.getDefaultAccounts('sole_trader');
    expect(accounts.some((a) => a.name === 'Superannuation Payable' && a.type === 'liability')).toBe(true);
    expect(accounts.some((a) => a.name === 'Superannuation' && a.type === 'expense')).toBe(true);
  });

  it('tags expense accounts with ITR-format tax categories', () => {
    const accounts = auChartOfAccounts.getDefaultAccounts('sole_trader');
    const expenseAccounts = accounts.filter((a) => a.type === 'expense');
    expect(expenseAccounts.every((a) => a.taxCategory)).toBe(true);
    expect(expenseAccounts.some((a) => a.taxCategory?.startsWith('ITR -'))).toBe(true);
  });

  it('provides a non-empty tax category mapping keyed by account code', () => {
    const mapping = auChartOfAccounts.getTaxCategoryMapping();
    expect(Object.keys(mapping).length).toBeGreaterThan(0);
    expect(mapping['5100']).toMatch(/Advertising|other expenses/i);
  });
});

describe('AU Installment Schedule (PAYG Instalments)', () => {
  it('returns 4 quarterly deadlines', () => {
    const deadlines = auInstallmentSchedule.getDeadlines(2025);
    expect(deadlines).toHaveLength(4);
  });

  it('has correct deadline months matching the Australian financial year (Oct, Feb, Apr, Jul)', () => {
    const deadlines = auInstallmentSchedule.getDeadlines(2025);
    expect(deadlines[0].deadline.getMonth()).toBe(9); // October
    expect(deadlines[1].deadline.getMonth()).toBe(1); // February
    expect(deadlines[2].deadline.getMonth()).toBe(3); // April
    expect(deadlines[3].deadline.getMonth()).toBe(6); // July
  });

  it('all deadlines fall on the 28th', () => {
    const deadlines = auInstallmentSchedule.getDeadlines(2025);
    for (const d of deadlines) expect(d.deadline.getDate()).toBe(28);
  });

  it('calculates the prior-year method as prior year tax / 4', () => {
    const amount = auInstallmentSchedule.calculateAmount('prior_year', 0, 800000);
    expect(amount).toBe(200000);
  });

  it('calculates the current-year method as a quarter of a 30%-rate annual estimate — matches the prior-year method\'s /4 pattern, not a bug', () => {
    // Same formula shape as us/ca/uk: annual-rate estimate (30% of YTD income),
    // divided into 4 equal quarterly instalments — 0.30 * 0.25 = 0.075 per quarter.
    const amount = auInstallmentSchedule.calculateAmount('current_year', 10000000, 0); // $100,000 YTD
    expect(amount).toBe(Math.round(10000000 * 0.25 * 0.30));
    expect(amount).toBe(750000);
  });
});

describe('AU Contractor Report (TPAR)', () => {
  it('uses the TPAR form', () => {
    expect(auContractorReport.formId).toBe('TPAR');
  });

  it('has a $0 threshold — every payment in a reportable industry is included', () => {
    expect(auContractorReport.threshold).toBe(0);
  });

  it('generates one TPAR report per contractor payment', () => {
    const payments = [
      { name: 'Alice', totalCents: 100000 },
      { name: 'Bob', totalCents: 1 },
    ];
    const reports = auContractorReport.generate(payments, 2025);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.formId === 'TPAR')).toBe(true);
    expect(reports.map((r) => r.contractorName)).toEqual(['Alice', 'Bob']);
  });

  it('returns an empty array when no payments are given', () => {
    expect(auContractorReport.generate([], 2025)).toHaveLength(0);
  });
});

describe('AU Mileage Rate', () => {
  it('returns the 2024-25 ATO rate of 88c/km', () => {
    const result = auMileageRate.getRate(2025, 3000);
    expect(result.rate).toBe(0.88);
    expect(result.unit).toBe('km');
  });

  it('returns the 2023-24 ATO rate of 85c/km', () => {
    const result = auMileageRate.getRate(2024, 3000);
    expect(result.rate).toBe(0.85);
  });

  it('falls back to the current rate for an unmapped future year', () => {
    const result = auMileageRate.getRate(2030, 1000);
    expect(result.rate).toBe(0.88);
  });

  it('does not flag the cents-per-km cap for distances at or under 5,000 km', () => {
    const result = auMileageRate.getRate(2025, 5000);
    expect(result.tierDescription).not.toMatch(/capped/i);
  });

  it('flags the cents-per-km cap for distances over 5,000 km', () => {
    const result = auMileageRate.getRate(2025, 6000);
    expect(result.tierDescription).toMatch(/capped at 5000 km/i);
  });
});

describe('AU Deductions', () => {
  it('lists the available deduction rules including home office, vehicle, and super', () => {
    const rules = auDeductions.getAvailableDeductions('sole_trader');
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('home_office_fixed_rate');
    expect(ids).toContain('motor_vehicle_cents');
    expect(ids).toContain('instant_asset_writeoff');
    expect(ids).toContain('super_contribution');
  });

  it('calculates home office fixed-rate deduction at 67c/hour', () => {
    expect(auDeductions.calculateDeduction('home_office_fixed_rate', { hours_per_year: 1000 })).toBe(67000);
  });

  it('calculates motor vehicle cents-per-km deduction, capped at 5,000 km', () => {
    expect(auDeductions.calculateDeduction('motor_vehicle_cents', { total_km: 3000 })).toBe(3000 * 88);
    expect(auDeductions.calculateDeduction('motor_vehicle_cents', { total_km: 8000 })).toBe(5000 * 88);
  });

  it('allows a full instant asset write-off under the $20,000 threshold, none over it', () => {
    expect(auDeductions.calculateDeduction('instant_asset_writeoff', { asset_cost_cents: 1500000 })).toBe(1500000);
    expect(auDeductions.calculateDeduction('instant_asset_writeoff', { asset_cost_cents: 2500000 })).toBe(0);
  });

  it('applies the correct small-business pool rate for first year vs. later years', () => {
    expect(auDeductions.calculateDeduction('depreciation_pool', { pool_value_cents: 1000000, first_year: 1 })).toBe(150000);
    expect(auDeductions.calculateDeduction('depreciation_pool', { pool_value_cents: 1000000, first_year: 0 })).toBe(300000);
  });

  it('caps the deductible super contribution at the $30,000 concessional cap', () => {
    expect(auDeductions.calculateDeduction('super_contribution', { super_contributions_cents: 4000000 })).toBe(3000000);
    expect(auDeductions.calculateDeduction('super_contribution', { super_contributions_cents: 1000000 })).toBe(1000000);
  });

  it('returns 0 for an unknown deduction rule', () => {
    expect(auDeductions.calculateDeduction('not_a_real_rule', {})).toBe(0);
  });
});

describe('AU Calendar Deadlines', () => {
  it('returns 15 deadlines for a tax year', () => {
    const deadlines = auCalendarDeadlines.getDeadlines(2025, 'au');
    expect(deadlines).toHaveLength(15);
  });

  it('computes the individual tax return due date as Oct 31 of the following calendar year', () => {
    const deadlines = auCalendarDeadlines.getDeadlines(2025, 'au');
    const due = deadlines.find((d) => d.titleKey === 'calendar.individual_tax_return_due');
    expect(due?.date).toBe('2026-10-31');
  });

  it('computes the financial year end as June 30 of the following calendar year', () => {
    const deadlines = auCalendarDeadlines.getDeadlines(2025, 'au');
    const fye = deadlines.find((d) => d.titleKey === 'calendar.financial_year_end');
    expect(fye?.date).toBe('2026-06-30');
  });

  it('Superannuation Guarantee due dates fall on the 28th of the month after quarter-end — one month earlier than the equivalent BAS quarter for Q2', () => {
    const deadlines = auCalendarDeadlines.getDeadlines(2025, 'au');
    const superQ2 = deadlines.find((d) => d.titleKey === 'calendar.super_q2_due');
    const basQ2 = deadlines.find((d) => d.titleKey === 'calendar.bas_q2_due');
    // Real ATO rule: SG is due Jan 28 for the Oct-Dec quarter, but BAS lodgment
    // for the same quarter isn't due until Feb 28 — these are correctly NOT
    // the same date, not a data-entry inconsistency.
    expect(superQ2?.date).toBe('2026-01-28');
    expect(basQ2?.date).toBe('2026-02-28');
  });

  it('every deadline has a valid urgency', () => {
    const deadlines = auCalendarDeadlines.getDeadlines(2025, 'au');
    for (const d of deadlines) {
      expect(['critical', 'important', 'informational']).toContain(d.urgency);
    }
  });
});
