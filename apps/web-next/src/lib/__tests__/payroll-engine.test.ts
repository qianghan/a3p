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

  it('all frequencies are defined', () => {
    expect(Object.keys(PERIODS_PER_YEAR)).toEqual(['weekly', 'biweekly', 'semimonthly', 'monthly']);
  });
});
