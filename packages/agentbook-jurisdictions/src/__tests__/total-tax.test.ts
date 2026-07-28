import { describe, it, expect } from 'vitest';
import { estimateTotalIncomeTax } from '../total-tax.js';
import { caTaxBrackets } from '../ca/tax-brackets.js';
import { caSelfEmploymentTax } from '../ca/self-employment-tax.js';
import { usTaxBrackets } from '../us/tax-brackets.js';
import { usSelfEmploymentTax } from '../us/self-employment-tax.js';
import { calculateStateTax } from '../sub-national-tax.js';

const YEAR = 2026;

describe('estimateTotalIncomeTax — canonical composer', () => {
  it('is zero for non-positive income', () => {
    expect(estimateTotalIncomeTax(0, 'us', 'CA', YEAR).totalTaxCents).toBe(0);
    expect(estimateTotalIncomeTax(-1000, 'ca', 'ON', YEAR).totalTaxCents).toBe(0);
  });

  it('CA/ON = SE + federal + provincial, each counted exactly once (no double-count)', () => {
    const net = 100_000_00;
    const se = caSelfEmploymentTax.calculate(net, YEAR);
    const taxable = Math.max(0, net - se.deductiblePortionCents);
    const federal = caTaxBrackets.calculateTax(taxable, YEAR).taxCents;      // federal only
    const provincial = calculateStateTax(taxable, 'ON', 'CA').taxCents;

    const r = estimateTotalIncomeTax(net, 'ca', 'ON', YEAR);
    expect(r.seTaxCents).toBe(se.amountCents);
    expect(r.incomeTaxCents).toBe(federal);                 // federal only — NOT fed+prov
    expect(r.stateTaxCents).toBe(provincial);               // provincial once
    expect(r.totalTaxCents).toBe(se.amountCents + federal + provincial);
    expect(r.stateModeled).toBe(true);
    // and it must exceed the federal-only (no-region) total by exactly provincial
    const noRegion = estimateTotalIncomeTax(net, 'ca', '', YEAR);
    expect(r.totalTaxCents - noRegion.totalTaxCents).toBe(provincial);
  });

  it('US includes state tax when the state is modeled (CA state), federal-only when not set', () => {
    const net = 120_000_00;
    const se = usSelfEmploymentTax.calculate(net, YEAR);
    const taxable = Math.max(0, net - se.deductiblePortionCents);
    const federal = usTaxBrackets.calculateTax(taxable, YEAR).taxCents;
    const caState = calculateStateTax(taxable, 'CA', 'US').taxCents;

    const withState = estimateTotalIncomeTax(net, 'us', 'CA', YEAR);
    expect(withState.totalTaxCents).toBe(se.amountCents + federal + caState);
    expect(caState).toBeGreaterThan(0);

    const noState = estimateTotalIncomeTax(net, 'us', '', YEAR);
    expect(noState.stateTaxCents).toBe(0);
    expect(noState.stateModeled).toBe(false); // disclose the gap
  });

  it('unmodeled region discloses the gap (stateModeled=false) and excludes state tax', () => {
    const r = estimateTotalIncomeTax(90_000_00, 'us', 'ZZ', YEAR);
    expect(r.stateTaxCents).toBe(0);
    expect(r.stateModeled).toBe(false);
  });
});
