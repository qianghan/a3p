/**
 * BAS (Business Activity Statement) GST computation — Australia. Aggregates the
 * tenant's own booked data into the ATO BAS GST labels for a reporting period:
 *
 *   G1  — total sales (GST-INCLUSIVE, i.e. gross)
 *   1A  — GST on sales (GST collected)          = Σ invoice.taxCents
 *   1B  — GST on purchases (input tax credits)  = Σ expense.taxAmountCents
 *   net GST (1A − 1B) — amount payable to / refundable from the ATO
 *
 * Like the CA GST/HST return, this is a PURE aggregation of already-recorded
 * tax amounts (no re-derivation from the 10% rate), so it never disagrees with
 * what the tenant actually invoiced/paid. DB-free + unit-testable; the query +
 * jurisdiction gate live in the route.
 *
 * Scope: the GST labels (G1/1A/1B). PAYG-withholding labels (W1/W2) depend on
 * payroll data and are a follow-on; a BAS with employees also reports those.
 */

export interface BasSalesLine {
  /** Gross sale incl. GST, in cents (invoice.amountCents). Feeds G1. */
  grossSalesCents: number;
  /** GST collected on this sale, in cents (invoice.taxCents). Feeds 1A. */
  gstCollectedCents: number;
}

export interface BasPurchaseLine {
  /** GST paid on this purchase, in cents (expense.taxAmountCents). Feeds 1B. */
  gstPaidCents: number;
}

export interface BasReturnInput {
  periodStart: string; // ISO date (inclusive)
  periodEnd: string; // ISO date (inclusive)
  sales: BasSalesLine[];
  purchases: BasPurchaseLine[];
}

export interface BasReturn {
  period: { start: string; end: string };
  g1TotalSalesCents: number; // GST-inclusive
  label1AGstOnSalesCents: number;
  label1BGstOnPurchasesCents: number;
  /** 1A − 1B. Positive = payable to ATO; negative = refund. */
  netGstCents: number;
  outcome: 'payable' | 'refund' | 'nil';
  counts: { salesCount: number; purchaseCount: number };
}

export function computeBasReturn(input: BasReturnInput): BasReturn {
  const g1 = input.sales.reduce((s, r) => s + Math.max(0, r.grossSalesCents), 0);
  const label1A = input.sales.reduce((s, r) => s + r.gstCollectedCents, 0);
  const label1B = input.purchases.reduce((s, p) => s + p.gstPaidCents, 0);
  const netGst = label1A - label1B;
  const outcome: BasReturn['outcome'] = netGst > 0 ? 'payable' : netGst < 0 ? 'refund' : 'nil';
  return {
    period: { start: input.periodStart, end: input.periodEnd },
    g1TotalSalesCents: g1,
    label1AGstOnSalesCents: label1A,
    label1BGstOnPurchasesCents: label1B,
    netGstCents: netGst,
    outcome,
    counts: { salesCount: input.sales.length, purchaseCount: input.purchases.length },
  };
}
