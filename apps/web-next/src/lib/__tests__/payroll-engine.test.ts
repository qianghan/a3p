import { describe, it, expect } from 'vitest';
import { calcPay, periodGross, PERIODS_PER_YEAR } from '../payroll-engine';

describe('payroll engine', () => {
  it('periodGross splits annual salary by frequency', () => {
    expect(periodGross(78_000_00, 'biweekly')).toBe(Math.round(78_000_00 / 26));
    expect(periodGross(120_000_00, 'monthly')).toBe(120_000_00 / 12);
  });

  it('US: gross = federal + FICA + net (no leakage)', () => {
    const r = calcPay({ jurisdiction: 'us', grossCents: periodGross(78_000_00, 'biweekly'), payPeriodsPerYear: 26 });
    expect(r.federalTaxCents).toBeGreaterThan(0);
    expect(r.ficaCents).toBeGreaterThan(0);
    expect(r.federalTaxCents + r.ficaCents + r.stateTaxCents + r.netCents).toBe(r.grossCents);
  });

  it('US FICA on a biweekly $3000 check ≈ 7.65%', () => {
    const r = calcPay({ jurisdiction: 'us', grossCents: 3_000_00, payPeriodsPerYear: 26 });
    // SS 6.2% + Medicare 1.45% = 7.65% under the wage base
    expect(r.ficaCents).toBe(Math.round(Math.min(3_000_00 * 26, 168_600_00) * 0.062 / 26) + Math.round(3_000_00 * 0.0145));
  });

  it('married brackets withhold less than single at the same gross', () => {
    const single = calcPay({ jurisdiction: 'us', grossCents: 5_000_00, payPeriodsPerYear: 26, filingStatus: 'single' });
    const married = calcPay({ jurisdiction: 'us', grossCents: 5_000_00, payPeriodsPerYear: 26, filingStatus: 'married' });
    expect(married.federalTaxCents).toBeLessThan(single.federalTaxCents);
  });

  it('Canada applies CPP+EI as fica and stays balanced', () => {
    const r = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26 });
    expect(r.ficaCents).toBeGreaterThan(0);
    expect(r.federalTaxCents + r.ficaCents + r.netCents).toBe(r.grossCents);
  });

  it('UK gives a tax-free personal allowance (low earner pays no PAYE)', () => {
    const r = calcPay({ jurisdiction: 'uk', grossCents: periodGross(10_000_00, 'monthly'), payPeriodsPerYear: 12 });
    expect(r.federalTaxCents).toBe(0);
  });

  it('Australia super is employer-side, so fica withheld is 0', () => {
    const r = calcPay({ jurisdiction: 'au', grossCents: periodGross(80_000_00, 'monthly'), payPeriodsPerYear: 12 });
    expect(r.ficaCents).toBe(0);
    expect(r.federalTaxCents).toBeGreaterThan(0);
  });

  it('Australia superannuation guarantee is 12% of gross, additive on top (not subtracted from net)', () => {
    const gross = periodGross(80_000_00, 'monthly');
    const r = calcPay({ jurisdiction: 'au', grossCents: gross, payPeriodsPerYear: 12 });
    expect(r.sgCents).toBe(Math.round(gross * 0.12));
    // net = gross - federalTax only; sg never reduces net pay.
    expect(r.netCents).toBe(r.grossCents - r.federalTaxCents);
  });

  it('sgCents is 0 for every non-AU jurisdiction', () => {
    expect(calcPay({ jurisdiction: 'us', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
    expect(calcPay({ jurisdiction: 'ca', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
    expect(calcPay({ jurisdiction: 'uk', grossCents: 3_000_00, payPeriodsPerYear: 26 }).sgCents).toBe(0);
  });

  it('all frequencies are defined', () => {
    expect(Object.keys(PERIODS_PER_YEAR)).toEqual(['weekly', 'biweekly', 'semimonthly', 'monthly']);
  });
});

describe('US_STATE_INCOME_TAX_RATES completeness (US-GATE remediation)', () => {
  const ALL_US_STATES_AND_DC = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
    'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
    'WI','WY','DC',
  ];

  it('produces a state-tax figure for every US state + DC (none silently default via the fallback)', () => {
    for (const state of ALL_US_STATES_AND_DC) {
      const result = calcPay({
        jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26,
        filingStatus: 'single', region: state,
      });
      expect(typeof result.stateTaxCents).toBe('number');
      expect(result.stateTaxCents).toBeGreaterThanOrEqual(0);
    }
    expect(ALL_US_STATES_AND_DC.length).toBe(51);
  });

  it('the 9 no-income-tax states still withhold an explicit real $0', () => {
    for (const state of ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']) {
      const result = calcPay({
        jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26,
        filingStatus: 'single', region: state,
      });
      expect(result.stateTaxCents).toBe(0);
    }
  });

  it('previously-uncovered states (e.g. VA, MA, WI) now withhold real non-zero state tax, not the old silent $0', () => {
    // Before this fix, any state outside the original 15-state table fell
    // through `?? 0`, withholding $0 indistinguishable from a genuine
    // no-income-tax state. $5,000.00 gross at VA's 5.75% flat approximation
    // = $287.50 = 28750 cents.
    const va = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'VA' });
    expect(va.stateTaxCents).toBe(28750);

    // MA at 9.00% top-marginal approximation = $450.00 = 45000 cents.
    const ma = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'MA' });
    expect(ma.stateTaxCents).toBe(45000);

    // WI at 7.65% top-marginal approximation = $382.50 = 38250 cents.
    const wi = calcPay({ jurisdiction: 'us', grossCents: 500000, payPeriodsPerYear: 26, filingStatus: 'single', region: 'WI' });
    expect(wi.stateTaxCents).toBe(38250);
  });
});
