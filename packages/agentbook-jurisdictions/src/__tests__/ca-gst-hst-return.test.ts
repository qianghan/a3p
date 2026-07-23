import { describe, it, expect } from 'vitest';
import { computeGstHstReturn } from '../ca/gst-hst-return.js';

describe('computeGstHstReturn (CA GST/HST return, Wave 2)', () => {
  const base = { periodStart: '2026-01-01', periodEnd: '2026-03-31' };

  it('nets GST collected (line 105) against ITCs (line 108) → line 109 balance owing', () => {
    const r = computeGstHstReturn({
      ...base,
      // $10,000 sales + $1,300 HST (ON 13%); $2,000 purchases + $260 HST paid.
      sales: [{ netSalesCents: 1_000_000, taxCollectedCents: 130_000 }],
      purchases: [{ taxPaidCents: 26_000 }],
    });
    expect(r.line101TotalSalesCents).toBe(1_000_000);
    expect(r.line105GstHstCollectedCents).toBe(130_000);
    expect(r.line108ItcCents).toBe(26_000);
    expect(r.line109NetTaxCents).toBe(104_000); // 130,000 − 26,000
    expect(r.outcome).toBe('balance_owing');
  });

  it('returns a refund when ITCs exceed GST collected', () => {
    const r = computeGstHstReturn({
      ...base,
      sales: [{ netSalesCents: 100_000, taxCollectedCents: 13_000 }],
      purchases: [{ taxPaidCents: 40_000 }],
    });
    expect(r.line109NetTaxCents).toBe(-27_000);
    expect(r.outcome).toBe('refund');
  });

  it('aggregates many sales/purchases and reports counts', () => {
    const r = computeGstHstReturn({
      ...base,
      sales: [
        { netSalesCents: 500_000, taxCollectedCents: 65_000 },
        { netSalesCents: 300_000, taxCollectedCents: 39_000 },
      ],
      purchases: [{ taxPaidCents: 10_000 }, { taxPaidCents: 5_000 }, { taxPaidCents: 0 }],
    });
    expect(r.line101TotalSalesCents).toBe(800_000);
    expect(r.line105GstHstCollectedCents).toBe(104_000);
    expect(r.line108ItcCents).toBe(15_000);
    expect(r.line109NetTaxCents).toBe(89_000);
    expect(r.counts).toEqual({ salesCount: 2, purchaseCount: 3 });
  });

  it('is nil when there is no activity', () => {
    const r = computeGstHstReturn({ ...base, sales: [], purchases: [] });
    expect(r.line109NetTaxCents).toBe(0);
    expect(r.outcome).toBe('nil');
  });
});
