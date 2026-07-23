import { describe, it, expect } from 'vitest';
import { calcPay } from '@/lib/payroll-engine';

describe('calcPay — US state income tax withholding', () => {
  it('withholds non-zero state tax for a US employee in California at the documented CA rate', () => {
    const result = calcPay({
      jurisdiction: 'us',
      grossCents: 400000, // $4,000 gross this period
      payPeriodsPerYear: 26,
      filingStatus: 'single',
      region: 'CA',
    });
    expect(result.stateTaxCents).toBe(Math.round(400000 * 0.1330));
    expect(result.stateTaxCents).toBeGreaterThan(0);
  });

  it('withholds exactly $0 state tax for a US employee in a no-income-tax state (TX)', () => {
    const result = calcPay({
      jurisdiction: 'us',
      grossCents: 400000,
      payPeriodsPerYear: 26,
      filingStatus: 'single',
      region: 'TX',
    });
    expect(result.stateTaxCents).toBe(0);
  });

  it('withholds exactly $0 state tax for a US employee in a no-income-tax state (FL)', () => {
    const result = calcPay({
      jurisdiction: 'us',
      grossCents: 400000,
      payPeriodsPerYear: 26,
      filingStatus: 'single',
      region: 'FL',
    });
    expect(result.stateTaxCents).toBe(0);
  });

  it('withholds $0 state tax when no region is set on the employee (unchanged default behavior, now explicit)', () => {
    const result = calcPay({
      jurisdiction: 'us',
      grossCents: 400000,
      payPeriodsPerYear: 26,
      filingStatus: 'single',
    });
    expect(result.stateTaxCents).toBe(0);
  });

  it('leaves UK calculations completely unaffected (stateTaxCents stays 0)', () => {
    const result = calcPay({
      jurisdiction: 'uk',
      grossCents: 400000,
      payPeriodsPerYear: 26,
    });
    expect(result.stateTaxCents).toBe(0);
  });

  it('leaves Australia calculations completely unaffected (stateTaxCents stays 0)', () => {
    const result = calcPay({
      jurisdiction: 'au',
      grossCents: 400000,
      payPeriodsPerYear: 26,
    });
    expect(result.stateTaxCents).toBe(0);
  });
});

describe('calcPay — CA/QC provincial income tax withholding', () => {
  it('withholds non-zero Ontario provincial income tax for a CA (ON) employee', () => {
    const result = calcPay({
      jurisdiction: 'ca',
      grossCents: 400000, // $4,000/period × 26 = $104,000/yr
      payPeriodsPerYear: 26,
      region: 'ON',
    });
    // stateTaxCents carries the PROVINCIAL portion (not federal, not CPP/EI).
    expect(result.stateTaxCents).toBeGreaterThan(0);
    // Net must be gross minus federal + provincial + CPP/EI, all subtracted.
    expect(result.netCents).toBe(
      result.grossCents - result.federalTaxCents - result.stateTaxCents - result.ficaCents,
    );
    // Sanity: provincial tax is materially smaller than federal at this income.
    expect(result.stateTaxCents).toBeLessThan(result.federalTaxCents);
  });

  it('applies Quebec provincial brackets (higher rate) for a CA (QC) employee', () => {
    const on = calcPay({ jurisdiction: 'ca', grossCents: 400000, payPeriodsPerYear: 26, region: 'ON' });
    const qc = calcPay({ jurisdiction: 'ca', grossCents: 400000, payPeriodsPerYear: 26, region: 'QC' });
    // Quebec's provincial rates are materially higher than Ontario's at this income.
    expect(qc.stateTaxCents).toBeGreaterThan(on.stateTaxCents);
  });

  it('defaults an unknown/absent province to Ontario rather than withholding $0 provincial tax', () => {
    const result = calcPay({ jurisdiction: 'ca', grossCents: 400000, payPeriodsPerYear: 26 });
    expect(result.stateTaxCents).toBeGreaterThan(0);
  });
});
