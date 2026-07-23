/**
 * GST/HST return computation (Canada). Aggregates the tenant's own booked data
 * into the CRA return's key lines for a reporting period:
 *
 *   line 101 — total sales & other revenue (GST/HST-exclusive)
 *   line 105 — total GST/HST collected/collectible on sales
 *   line 108 — total input tax credits (ITCs = GST/HST paid on purchases)
 *   line 109 — net tax (105 − 108): positive → remit to CRA, negative → refund
 *
 * This is a PURE aggregation of already-recorded tax amounts — GST collected
 * comes from each invoice's persisted `taxCents`, ITCs from each expense's
 * persisted `taxAmountCents`. It does NOT re-derive tax from rates (the rate
 * was applied and stored when the invoice/expense was booked), so it never
 * disagrees with what the tenant actually invoiced or paid. The DB query +
 * jurisdiction gate live in the route; this module stays DB-free and unit-
 * testable, matching the other ca/* pack helpers.
 */

export interface GstHstSalesLine {
  /** Revenue net of GST/HST, in cents (invoice amount − its tax portion). */
  netSalesCents: number;
  /** GST/HST collected on this sale, in cents (invoice.taxCents). */
  taxCollectedCents: number;
}

export interface GstHstPurchaseLine {
  /** GST/HST paid on this purchase, in cents (expense.taxAmountCents). Eligible ITC. */
  taxPaidCents: number;
}

export interface GstHstReturnInput {
  periodStart: string; // ISO date (inclusive)
  periodEnd: string; // ISO date (inclusive)
  sales: GstHstSalesLine[];
  purchases: GstHstPurchaseLine[];
}

export interface GstHstReturn {
  period: { start: string; end: string };
  line101TotalSalesCents: number;
  line105GstHstCollectedCents: number;
  line108ItcCents: number;
  /** 105 − 108. Positive = balance owing to CRA; negative = refund. */
  line109NetTaxCents: number;
  outcome: 'balance_owing' | 'refund' | 'nil';
  counts: { salesCount: number; purchaseCount: number };
}

export function computeGstHstReturn(input: GstHstReturnInput): GstHstReturn {
  const line101 = input.sales.reduce((s, r) => s + Math.max(0, r.netSalesCents), 0);
  const line105 = input.sales.reduce((s, r) => s + r.taxCollectedCents, 0);
  const line108 = input.purchases.reduce((s, p) => s + p.taxPaidCents, 0);
  const line109 = line105 - line108;
  const outcome: GstHstReturn['outcome'] = line109 > 0 ? 'balance_owing' : line109 < 0 ? 'refund' : 'nil';
  return {
    period: { start: input.periodStart, end: input.periodEnd },
    line101TotalSalesCents: line101,
    line105GstHstCollectedCents: line105,
    line108ItcCents: line108,
    line109NetTaxCents: line109,
    outcome,
    counts: { salesCount: input.sales.length, purchaseCount: input.purchases.length },
  };
}
