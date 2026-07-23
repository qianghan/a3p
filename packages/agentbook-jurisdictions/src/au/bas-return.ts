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

export interface BasWageLine {
  /** Gross salary/wages paid this period, in cents (pay stub grossCents). Feeds W1. */
  grossCents: number;
  /** PAYG amount withheld, in cents (pay stub federalTaxCents for AU). Feeds W2. */
  paygWithheldCents: number;
}

export interface BasReturnInput {
  periodStart: string; // ISO date (inclusive)
  periodEnd: string; // ISO date (inclusive)
  sales: BasSalesLine[];
  purchases: BasPurchaseLine[];
  /** Employer pay stubs in the period. Omit for a GST-only BAS (no employees). */
  wages?: BasWageLine[];
}

export interface BasReturn {
  period: { start: string; end: string };
  g1TotalSalesCents: number; // GST-inclusive
  label1AGstOnSalesCents: number;
  label1BGstOnPurchasesCents: number;
  /** 1A − 1B. Positive = GST payable; negative = GST refund. */
  netGstCents: number;
  // PAYG withholding labels (present even when 0, so employer BAS is complete).
  w1TotalWagesCents: number;
  w2PaygWithheldCents: number;
  /** The BAS bottom line remitted to the ATO: net GST + PAYG withheld (W2). */
  totalPayableCents: number;
  /** Reflects totalPayableCents (net GST + W2), i.e. the actual BAS outcome. */
  outcome: 'payable' | 'refund' | 'nil';
  counts: { salesCount: number; purchaseCount: number; wageCount: number };
}

export function computeBasReturn(input: BasReturnInput): BasReturn {
  const wages = input.wages ?? [];
  const g1 = input.sales.reduce((s, r) => s + Math.max(0, r.grossSalesCents), 0);
  const label1A = input.sales.reduce((s, r) => s + r.gstCollectedCents, 0);
  const label1B = input.purchases.reduce((s, p) => s + p.gstPaidCents, 0);
  const netGst = label1A - label1B;
  const w1 = wages.reduce((s, w) => s + Math.max(0, w.grossCents), 0);
  const w2 = wages.reduce((s, w) => s + w.paygWithheldCents, 0);
  // The BAS bottom line the employer remits: net GST plus PAYG withheld. PAYG-W
  // is always owed to the ATO (it's employees' tax), so it adds to the liability
  // and can turn a GST refund into a net payment.
  const totalPayable = netGst + w2;
  const outcome: BasReturn['outcome'] = totalPayable > 0 ? 'payable' : totalPayable < 0 ? 'refund' : 'nil';
  return {
    period: { start: input.periodStart, end: input.periodEnd },
    g1TotalSalesCents: g1,
    label1AGstOnSalesCents: label1A,
    label1BGstOnPurchasesCents: label1B,
    netGstCents: netGst,
    w1TotalWagesCents: w1,
    w2PaygWithheldCents: w2,
    totalPayableCents: totalPayable,
    outcome,
    counts: { salesCount: input.sales.length, purchaseCount: input.purchases.length, wageCount: wages.length },
  };
}
