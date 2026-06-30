import { describe, it, expect } from 'vitest';
import { parseReceiptJson } from '../receipt-parse';

describe('receipt parse', () => {
  it('parses clean JSON from the model', () => {
    const r = parseReceiptJson('{"total": 45.99, "vendor": "Starbucks", "date": "2026-06-12"}');
    expect(r.amountCents).toBe(4599);
    expect(r.vendor).toBe('Starbucks');
    expect(r.date).toBe('2026-06-12');
  });
  it('strips ```json fences', () => {
    const r = parseReceiptJson('```json\n{"total": 12, "vendor": "X"}\n```');
    expect(r.amountCents).toBe(1200);
    expect(r.vendor).toBe('X');
  });
  it('falls back to amount when total is absent', () => {
    const r = parseReceiptJson('{"amount": 8.5, "vendor": "Y"}');
    expect(r.amountCents).toBe(850);
  });
  it('returns nulls on garbage', () => {
    const r = parseReceiptJson('not json at all');
    expect(r.amountCents).toBeNull();
    expect(r.vendor).toBeNull();
    expect(r.date).toBeNull();
  });
  it('ignores empty vendor/date strings', () => {
    const r = parseReceiptJson('{"total": 5, "vendor": "", "date": ""}');
    expect(r.amountCents).toBe(500);
    expect(r.vendor).toBeNull();
    expect(r.date).toBeNull();
  });
});
