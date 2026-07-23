import { describe, it, expect } from 'vitest';
import { computeBasReturn } from '../au/bas-return.js';

describe('computeBasReturn (AU BAS GST, Wave 2)', () => {
  const base = { periodStart: '2026-01-01', periodEnd: '2026-03-31' };

  it('reports G1 (gross sales), 1A (GST collected), 1B (ITCs) and net GST payable', () => {
    const r = computeBasReturn({
      ...base,
      // $10,000 sale + $1,000 GST (10%) → gross $11,000; $2,200 purchase incl $200 GST.
      sales: [{ grossSalesCents: 1_100_000, gstCollectedCents: 100_000 }],
      purchases: [{ gstPaidCents: 20_000 }],
    });
    expect(r.g1TotalSalesCents).toBe(1_100_000); // GST-inclusive
    expect(r.label1AGstOnSalesCents).toBe(100_000);
    expect(r.label1BGstOnPurchasesCents).toBe(20_000);
    expect(r.netGstCents).toBe(80_000); // 1A − 1B
    expect(r.outcome).toBe('payable');
  });

  it('is a refund when 1B exceeds 1A', () => {
    const r = computeBasReturn({
      ...base,
      sales: [{ grossSalesCents: 110_000, gstCollectedCents: 10_000 }],
      purchases: [{ gstPaidCents: 30_000 }],
    });
    expect(r.netGstCents).toBe(-20_000);
    expect(r.outcome).toBe('refund');
  });

  it('aggregates multiple lines with counts, nil when empty', () => {
    const multi = computeBasReturn({
      ...base,
      sales: [{ grossSalesCents: 550_000, gstCollectedCents: 50_000 }, { grossSalesCents: 220_000, gstCollectedCents: 20_000 }],
      purchases: [{ gstPaidCents: 5_000 }],
    });
    expect(multi.g1TotalSalesCents).toBe(770_000);
    expect(multi.label1AGstOnSalesCents).toBe(70_000);
    expect(multi.netGstCents).toBe(65_000);
    expect(multi.counts).toEqual({ salesCount: 2, purchaseCount: 1, wageCount: 0 });

    const nil = computeBasReturn({ ...base, sales: [], purchases: [] });
    expect(nil.netGstCents).toBe(0);
    expect(nil.outcome).toBe('nil');
    expect(nil.w1TotalWagesCents).toBe(0);
    expect(nil.totalPayableCents).toBe(0);
  });

  it('includes PAYG-W labels (W1/W2) and adds W2 to the total payable', () => {
    const r = computeBasReturn({
      ...base,
      sales: [{ grossSalesCents: 110_000, gstCollectedCents: 10_000 }],
      purchases: [{ gstPaidCents: 4_000 }],
      wages: [
        { grossCents: 500_000, paygWithheldCents: 90_000 },
        { grossCents: 300_000, paygWithheldCents: 50_000 },
      ],
    });
    expect(r.w1TotalWagesCents).toBe(800_000);
    expect(r.w2PaygWithheldCents).toBe(140_000);
    expect(r.netGstCents).toBe(6_000); // 10,000 − 4,000
    expect(r.totalPayableCents).toBe(146_000); // net GST 6,000 + PAYG-W 140,000
    expect(r.outcome).toBe('payable');
    expect(r.counts.wageCount).toBe(2);
  });

  it('PAYG-W turns a GST refund into a net payment', () => {
    const r = computeBasReturn({
      ...base,
      sales: [{ grossSalesCents: 11_000, gstCollectedCents: 1_000 }],
      purchases: [{ gstPaidCents: 5_000 }], // GST net = −4,000 (refund)
      wages: [{ grossCents: 200_000, paygWithheldCents: 30_000 }],
    });
    expect(r.netGstCents).toBe(-4_000);
    expect(r.totalPayableCents).toBe(26_000); // −4,000 + 30,000
    expect(r.outcome).toBe('payable');
  });
});
