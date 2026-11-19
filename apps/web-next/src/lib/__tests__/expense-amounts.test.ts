import { describe, it, expect } from 'vitest';
import { deductibleCents, sumDeductibleCents } from '../expense-amounts';

describe('deductibleCents', () => {
  it('AU registrant typed expense: $110 incl GST, $10 recoverable -> 10000', () => {
    expect(deductibleCents({ amountCents: 11000, recoverableTaxCents: 1000 })).toBe(10000);
  });
  it('untyped legacy row (recoverableTaxCents null/undefined/0) -> gross', () => {
    expect(deductibleCents({ amountCents: 5000, recoverableTaxCents: null })).toBe(5000);
    expect(deductibleCents({ amountCents: 5000 })).toBe(5000);
    expect(deductibleCents({ amountCents: 5000, recoverableTaxCents: 0 })).toBe(5000);
  });
  it('refund / negative amounts keep sign', () => {
    expect(deductibleCents({ amountCents: -11000, recoverableTaxCents: -1000 })).toBe(-10000);
    expect(deductibleCents({ amountCents: -5000, recoverableTaxCents: 0 })).toBe(-5000);
  });
  it('sumDeductibleCents totals a mixed fixture to 15000, not 16000', () => {
    expect(sumDeductibleCents([
      { amountCents: 11000, recoverableTaxCents: 1000 },
      { amountCents: 5000, recoverableTaxCents: null },
    ])).toBe(15000);
  });
  it('sumDeductibleCents accepts aggregate shape', () => {
    expect(sumDeductibleCents({ amountCents: 16000, recoverableTaxCents: 1000 })).toBe(15000);
    expect(sumDeductibleCents({ amountCents: null, recoverableTaxCents: null })).toBe(0);
  });
});
