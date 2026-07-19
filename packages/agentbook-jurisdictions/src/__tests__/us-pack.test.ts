import { describe, it, expect } from 'vitest';
import { usTaxBrackets } from '../us/tax-brackets.js';
import { usSelfEmploymentTax } from '../us/self-employment-tax.js';
import { usSalesTax, STATE_RATES } from '../us/sales-tax.js';
import { usChartOfAccounts } from '../us/chart-of-accounts.js';
import { usInstallmentSchedule } from '../us/installment-schedule.js';
import { usContractorReport } from '../us/contractor-report.js';
import { usMileageRate } from '../us/mileage-rate.js';

describe('US Tax Brackets', () => {
  it('has jurisdiction set to "us"', () => {
    expect(usTaxBrackets.jurisdiction).toBe('us');
  });

  it('calculates correct federal tax on $50,000 income', () => {
    // $50,000 = 5,000,000 cents. Real IRS 2025 single-filer thresholds
    // (Rev. Proc. 2024-40): $11,925 / $48,475 / $103,350 / ...
    // 10% on first $11,925 (1,192,500 cents) = $1,192.50 -> 119,250
    // 12% on $11,925-$48,475 ($36,550 = 3,655,000 cents) = $4,386 -> 438,600
    // 22% on $48,475-$50,000 ($1,525 = 152,500 cents) = $335.50 -> 33,550
    const result = usTaxBrackets.calculateTax(5000000, 2025);

    // Bracket 1: 10% on 1,192,500 = 119,250
    expect(result.bracketBreakdown[0].taxCents).toBe(119250);
    // Bracket 2: 12% on (4,847,500 - 1,192,500) = 3,655,000 * 0.12 = 438,600
    expect(result.bracketBreakdown[1].taxCents).toBe(438600);
    // Bracket 3: 22% on (5,000,000 - 4,847,500) = 152,500 * 0.22 = 33,550
    expect(result.bracketBreakdown[2].taxCents).toBe(33550);

    const expectedTotalCents = 119250 + 438600 + 33550; // 591,400 cents = $5,914.00
    expect(result.taxCents).toBe(expectedTotalCents);
  });

  it('returns effective rate less than marginal rate', () => {
    const result = usTaxBrackets.calculateTax(5000000, 2025);
    expect(result.effectiveRate).toBeLessThan(result.marginalRate);
    expect(result.marginalRate).toBe(0.22);
  });

  it('returns zero tax for zero income', () => {
    const result = usTaxBrackets.calculateTax(0, 2025);
    expect(result.taxCents).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });
});

describe('US Self-Employment Tax', () => {
  it('calculates SE tax on $100,000 net income correctly', () => {
    // $100,000 = 10,000,000 cents
    const result = usSelfEmploymentTax.calculate(10000000, 2025);

    // Taxable base: 92.35% of 10,000,000 = 9,235,000
    const taxableBase = Math.round(10000000 * 0.9235); // 9,235,000
    expect(taxableBase).toBe(9235000);

    // SS: 12.4% on 9,235,000 (under $184,500 cap) = 1,145,140
    const expectedSS = Math.round(9235000 * 0.124);
    expect(result.breakdown.social_security).toBe(expectedSS);

    // Medicare: 2.9% on 9,235,000 = 267,815
    const expectedMedicare = Math.round(9235000 * 0.029);
    expect(result.breakdown.medicare).toBe(expectedMedicare);

    // No additional Medicare (under $200k)
    expect(result.breakdown.additional_medicare).toBe(0);

    expect(result.amountCents).toBe(expectedSS + expectedMedicare);
  });

  it('deductible portion is half of total SE tax', () => {
    const result = usSelfEmploymentTax.calculate(10000000, 2025);
    expect(result.deductiblePortionCents).toBe(Math.round(result.amountCents / 2));
  });

  it('applies additional Medicare tax above $200,000', () => {
    // $250,000 = 25,000,000 cents
    const result = usSelfEmploymentTax.calculate(25000000, 2025);
    const taxableBase = Math.round(25000000 * 0.9235); // 23,087,500
    const additionalMedicareBase = taxableBase - 20000000; // 3,087,500
    const expectedAdditional = Math.round(additionalMedicareBase * 0.009);
    expect(result.breakdown.additional_medicare).toBe(expectedAdditional);
  });

  it('SS tax caps at 12.4% of the current $184,500 (2026) wage base for a high earner, not a year-stale figure', () => {
    // Pins the real cap constant directly (via a taxable base well above it)
    // rather than just re-deriving whatever the code currently does, so this
    // fails loudly if ssWageCap drifts again — this file and
    // apps/web-next/src/lib/payroll-engine.ts's US_SS_WAGE_BASE must agree,
    // since they compute the same real-world SS wage base for two different
    // tax calculations (SE tax estimate vs. payroll withholding).
    const result = usSelfEmploymentTax.calculate(50000000, 2026); // $500,000 net SE income
    expect(result.breakdown.social_security).toBe(Math.round(18450000 * 0.124));
  });
});

describe('US Sales Tax', () => {
  it('returns 7.25% rate for California', () => {
    const rates = usSalesTax.getRates('CA');
    expect(rates).toHaveLength(1);
    expect(rates[0].rate).toBe(0.0725);
    expect(rates[0].taxType).toBe('state');
  });

  it('returns 0% (no rates) for Oregon', () => {
    const rates = usSalesTax.getRates('OR');
    expect(rates).toHaveLength(0);
  });

  it('calculates tax correctly for CA', () => {
    const result = usSalesTax.calculateTax(10000, 'CA'); // $100.00
    expect(result.totalRate).toBe(0.0725);
    expect(result.totalCents).toBe(Math.round(10000 * 0.0725)); // 725
  });

  it('returns zero tax for states with no sales tax', () => {
    const result = usSalesTax.calculateTax(10000, 'OR');
    expect(result.totalRate).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.components).toHaveLength(0);
  });

  it('handles case-insensitive region codes', () => {
    const rates = usSalesTax.getRates('ca');
    expect(rates[0].rate).toBe(0.0725);
  });
});

describe('usSalesTax STATE_RATES completeness (US-GATE remediation)', () => {
  const ALL_US_STATES_AND_DC = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
    'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
    'WI','WY','DC',
  ];

  it('STATE_RATES has an own, explicit entry for every US state + DC — exactly 51, none more or fewer', () => {
    // A real membership check against the exported table itself — not just
    // calculateTax's `?? 0` output, which can't tell "genuinely zero" apart
    // from "entry deleted". This is the test that actually fails if a
    // future edit removes a state: Object.keys would simply be shorter.
    const tableKeys = Object.keys(STATE_RATES).sort();
    expect(tableKeys).toEqual([...ALL_US_STATES_AND_DC].sort());
    expect(tableKeys.length).toBe(51);
    for (const state of ALL_US_STATES_AND_DC) {
      expect(Object.prototype.hasOwnProperty.call(STATE_RATES, state)).toBe(true);
      expect(typeof STATE_RATES[state]).toBe('number');
    }
  });

  it('the 5 genuinely no-sales-tax states still compute to an explicit real $0, not a fallback $0', () => {
    for (const state of ['OR', 'NH', 'MT', 'DE', 'AK']) {
      const result = usSalesTax.calculateTax(10000, state);
      expect(result.totalRate).toBe(0);
      expect(result.totalCents).toBe(0);
      expect(result.components).toEqual([]);
    }
  });

  it('previously-uncovered states (e.g. VA, MA, WI) now compute real non-zero tax, not the old silent $0', () => {
    // Before this fix, VA/MA/WI fell through STATE_RATES's `?? 0` fallback,
    // producing $0 indistinguishable from an intentional no-tax state.
    const va = usSalesTax.calculateTax(10000, 'VA'); // $100.00 at 5.30%
    expect(va.totalRate).toBe(0.053);
    expect(va.totalCents).toBe(530);

    const ma = usSalesTax.calculateTax(10000, 'MA'); // $100.00 at 6.25%
    expect(ma.totalRate).toBe(0.0625);
    expect(ma.totalCents).toBe(625);

    const wi = usSalesTax.calculateTax(10000, 'WI'); // $100.00 at 5.00%
    expect(wi.totalRate).toBe(0.05);
    expect(wi.totalCents).toBe(500);
  });
});

describe('US Chart of Accounts', () => {
  it('returns Schedule C aligned accounts', () => {
    const accounts = usChartOfAccounts.getDefaultAccounts('sole_proprietor');
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('has all account types (asset, liability, equity, revenue, expense)', () => {
    const accounts = usChartOfAccounts.getDefaultAccounts('sole_proprietor');
    const types = new Set(accounts.map(a => a.type));
    expect(types).toContain('asset');
    expect(types).toContain('liability');
    expect(types).toContain('equity');
    expect(types).toContain('revenue');
    expect(types).toContain('expense');
  });

  it('has expense accounts with Schedule C tax categories', () => {
    const accounts = usChartOfAccounts.getDefaultAccounts('sole_proprietor');
    const expenseAccounts = accounts.filter(a => a.type === 'expense');
    const allHaveTaxCategory = expenseAccounts.every(a => a.taxCategory);
    expect(allHaveTaxCategory).toBe(true);
    // Verify some specific Schedule C lines
    const taxCategories = expenseAccounts.map(a => a.taxCategory);
    expect(taxCategories.some(c => c?.includes('Line 8'))).toBe(true);
    expect(taxCategories.some(c => c?.includes('Line 9'))).toBe(true);
  });

  it('provides tax category mapping', () => {
    const mapping = usChartOfAccounts.getTaxCategoryMapping();
    expect(Object.keys(mapping).length).toBeGreaterThan(0);
    // code '5000' should map to Advertising line
    expect(mapping['5000']).toMatch(/Advertising/);
  });
});

describe('US Installment Schedule', () => {
  it('returns 4 quarterly deadlines', () => {
    const deadlines = usInstallmentSchedule.getDeadlines(2025);
    expect(deadlines).toHaveLength(4);
  });

  it('has correct deadline months: Apr, Jun, Sep, Jan(next year)', () => {
    const deadlines = usInstallmentSchedule.getDeadlines(2025);
    // JavaScript months are 0-indexed: 3=Apr, 5=Jun, 8=Sep, 0=Jan
    expect(deadlines[0].deadline.getMonth()).toBe(3);  // April
    expect(deadlines[1].deadline.getMonth()).toBe(5);  // June
    expect(deadlines[2].deadline.getMonth()).toBe(8);  // September
    expect(deadlines[3].deadline.getMonth()).toBe(0);  // January (next year)
    expect(deadlines[3].deadline.getFullYear()).toBe(2026);
  });

  it('all deadlines fall on the 15th', () => {
    const deadlines = usInstallmentSchedule.getDeadlines(2025);
    for (const d of deadlines) {
      expect(d.deadline.getDate()).toBe(15);
    }
  });

  it('calculates safe harbor amount as prior year tax / 4', () => {
    const amount = usInstallmentSchedule.calculateAmount('safe_harbor', 0, 1000000);
    expect(amount).toBe(250000);
  });
});

describe('US Contractor Report', () => {
  it('uses 1099-NEC form', () => {
    expect(usContractorReport.formId).toBe('1099-NEC');
  });

  it('has $600 threshold (60000 cents)', () => {
    expect(usContractorReport.threshold).toBe(60000);
  });

  it('filters contractors by $600 threshold', () => {
    const payments = [
      { name: 'Alice', totalCents: 100000 },  // $1,000 - above
      { name: 'Bob', totalCents: 50000 },      // $500 - below
      { name: 'Carol', totalCents: 60000 },    // $600 - exactly at threshold
      { name: 'Dave', totalCents: 59999 },     // $599.99 - below
    ];
    const reports = usContractorReport.generate(payments, 2025);
    expect(reports).toHaveLength(2);
    expect(reports.map(r => r.contractorName)).toEqual(['Alice', 'Carol']);
  });

  it('returns empty array when no payments meet threshold', () => {
    const payments = [
      { name: 'Alice', totalCents: 10000 },
      { name: 'Bob', totalCents: 5000 },
    ];
    const reports = usContractorReport.generate(payments, 2025);
    expect(reports).toHaveLength(0);
  });
});

describe('US Mileage Rate', () => {
  it('returns $0.70/mile for 2025', () => {
    const result = usMileageRate.getRate(2025, 10000);
    expect(result.rate).toBe(0.70);
  });

  it('unit is "mile"', () => {
    const result = usMileageRate.getRate(2025, 10000);
    expect(result.unit).toBe('mile');
  });

  it('returns a rate even for unknown years (defaults to 0.70)', () => {
    const result = usMileageRate.getRate(2030, 5000);
    expect(result.rate).toBe(0.70);
  });
});
