import { describe, it, expect } from 'vitest';
import { calcScenarioTax } from '../server';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import { usSelfEmploymentTax } from '@agentbook/jurisdictions/us/self-employment-tax';
import { caSelfEmploymentTax } from '@agentbook/jurisdictions/ca/self-employment-tax';
import { auSelfEmploymentTax } from '@agentbook/jurisdictions/au/self-employment-tax';

describe('calcScenarioTax (PARITY-2)', () => {
  it('returns 0 for zero or negative net income (no crash, no negative tax)', () => {
    expect(calcScenarioTax(0, 'us', 2026)).toBe(0);
    expect(calcScenarioTax(-5_000_00, 'us', 2026)).toBe(0);
    expect(calcScenarioTax(-5_000_00, 'ca', 2026)).toBe(0);
    expect(calcScenarioTax(-5_000_00, 'au', 2026)).toBe(0);
  });

  it('US $100,000 net income matches direct composition of the real US calculators', () => {
    const net = 100_000_00;
    const se = usSelfEmploymentTax.calculate(net, 2026);
    const taxable = Math.max(0, net - se.deductiblePortionCents);
    const expectedIncomeTax = usTaxBrackets.calculateTax(taxable, 2026).taxCents;
    expect(calcScenarioTax(net, 'us', 2026)).toBe(se.amountCents + expectedIncomeTax);
  });

  it('CA $100,000 net income matches direct composition of the real CA calculators', () => {
    const net = 100_000_00;
    const se = caSelfEmploymentTax.calculate(net, 2026);
    const taxable = Math.max(0, net - se.deductiblePortionCents);
    const expectedIncomeTax = caTaxBrackets.calculateTax(taxable, 2026).taxCents;
    expect(calcScenarioTax(net, 'ca', 2026)).toBe(se.amountCents + expectedIncomeTax);
  });

  it('AU $100,000 net income matches direct composition of the real AU calculators', () => {
    const net = 100_000_00;
    const se = auSelfEmploymentTax.calculate(net, 2026);
    const taxable = Math.max(0, net - se.deductiblePortionCents);
    const expectedIncomeTax = auTaxBrackets.calculateTax(taxable, 2026).taxCents;
    expect(calcScenarioTax(net, 'au', 2026)).toBe(se.amountCents + expectedIncomeTax);
  });

  it('CA and AU produce different results from US for the same income (jurisdiction-aware, not a flat rate)', () => {
    const net = 120_000_00;
    const us = calcScenarioTax(net, 'us', 2026);
    const ca = calcScenarioTax(net, 'ca', 2026);
    const au = calcScenarioTax(net, 'au', 2026);
    expect(ca).not.toBe(us);
    expect(au).not.toBe(us);
    expect(ca).not.toBe(au);
  });

  it('unknown jurisdiction falls back to US brackets with $0 self-employment tax', () => {
    const net = 80_000_00;
    const result = calcScenarioTax(net, 'uk', 2026);
    const expectedIncomeTax = usTaxBrackets.calculateTax(net, 2026).taxCents;
    expect(result).toBe(expectedIncomeTax);
  });
});
