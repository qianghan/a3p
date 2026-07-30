import { describe, it, expect } from 'vitest';
import {
  isValidMoneyCents,
  validateInvoiceLines,
  validateTaxRateOverride,
  MAX_MONEY_CENTS,
  MAX_QUANTITY,
} from '../money-validation';

describe('isValidMoneyCents', () => {
  it('accepts whole, non-negative, in-range cents', () => {
    expect(isValidMoneyCents(0)).toBe(true);
    expect(isValidMoneyCents(4200)).toBe(true);
    expect(isValidMoneyCents(MAX_MONEY_CENTS)).toBe(true);
  });

  it('rejects the shapes that used to poison the ledger', () => {
    expect(isValidMoneyCents(undefined)).toBe(false);       // missing rateCents → was NaN
    expect(isValidMoneyCents(null)).toBe(false);
    expect(isValidMoneyCents('100' as unknown)).toBe(false); // string
    expect(isValidMoneyCents(NaN)).toBe(false);
    expect(isValidMoneyCents(Infinity)).toBe(false);
    expect(isValidMoneyCents(-1)).toBe(false);               // backdoor credit
    expect(isValidMoneyCents(10.5)).toBe(false);             // fractional cents
    expect(isValidMoneyCents(MAX_MONEY_CENTS + 1)).toBe(false); // Int column overflow
  });
});

describe('validateInvoiceLines', () => {
  it('normalizes valid lines, defaults quantity to 1, and sums the subtotal', () => {
    const r = validateInvoiceLines([
      { description: 'Consulting', quantity: 2, rateCents: 50_000 },
      { rateCents: 1_000 }, // no quantity, no description
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]).toEqual({ description: 'Consulting', quantity: 2, rateCents: 50_000, amountCents: 100_000 });
    expect(r.lines[1]).toEqual({ description: '', quantity: 1, rateCents: 1_000, amountCents: 1_000 });
    expect(r.subtotalCents).toBe(101_000);
  });

  it('allows fractional quantities (billable hours) and rounds the amount', () => {
    const r = validateInvoiceLines([{ quantity: 1.5, rateCents: 10_001 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0].amountCents).toBe(15_002); // round(1.5 * 10001) = 15001.5 → 15002
  });

  it('rejects a missing rateCents (the NaN bug) and names the line', () => {
    const r = validateInvoiceLines([{ description: 'ok', rateCents: 100 }, { description: 'bad' } as never]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/line 2/);
    expect(r.error).toMatch(/rateCents/);
  });

  it('rejects a negative rateCents (backdoor credit note)', () => {
    const r = validateInvoiceLines([{ rateCents: -5_000 }]);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-numeric rateCents', () => {
    const r = validateInvoiceLines([{ rateCents: 'abc' as unknown as number }]);
    expect(r.ok).toBe(false);
  });

  it('rejects a zero, negative, non-finite, or absurd quantity', () => {
    expect(validateInvoiceLines([{ quantity: 0, rateCents: 100 }]).ok).toBe(false);
    expect(validateInvoiceLines([{ quantity: -2, rateCents: 100 }]).ok).toBe(false);
    expect(validateInvoiceLines([{ quantity: NaN, rateCents: 100 }]).ok).toBe(false);
    expect(validateInvoiceLines([{ quantity: MAX_QUANTITY + 1, rateCents: 100 }]).ok).toBe(false);
  });

  it('rejects a subtotal that would overflow the money column, even from valid lines', () => {
    const big = { rateCents: MAX_MONEY_CENTS };
    const r = validateInvoiceLines([big, big]); // each valid alone; sum is not
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/total amount exceeds/);
  });

  it('accepts an empty list (the caller enforces "at least one line")', () => {
    const r = validateInvoiceLines([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subtotalCents).toBe(0);
  });
});

describe('validateTaxRateOverride', () => {
  it('treats absent/null as "use the jurisdiction default"', () => {
    expect(validateTaxRateOverride(undefined)).toEqual({ ok: true, rate: null });
    expect(validateTaxRateOverride(null)).toEqual({ ok: true, rate: null });
  });

  it('accepts a fraction in [0, 1]', () => {
    expect(validateTaxRateOverride(0)).toEqual({ ok: true, rate: 0 });
    expect(validateTaxRateOverride(0.1)).toEqual({ ok: true, rate: 0.1 });
    expect(validateTaxRateOverride(1)).toEqual({ ok: true, rate: 1 });
  });

  it('rejects a negative, >100%, or non-numeric rate', () => {
    expect(validateTaxRateOverride(-0.1).ok).toBe(false);
    expect(validateTaxRateOverride(5).ok).toBe(false);      // 500% tax
    expect(validateTaxRateOverride(NaN).ok).toBe(false);
    expect(validateTaxRateOverride('0.1').ok).toBe(false);
  });
});
