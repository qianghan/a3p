/**
 * BAS (Business Activity Statement) GST computation — Australia. Aggregates the
 * tenant's own booked data into the ATO BAS GST labels for a reporting period:
 *
 *   G1  — total sales (GST-INCLUSIVE, i.e. gross)
 *   1A  — GST on sales (GST collected)          = Σ invoice.taxCents
 *   1B  — GST on purchases (input tax credits)  = Σ typed recoverableTaxCents
 *         + Σ untyped taxAmountCents; 0 when gstRegistered === false
 *   G10 — capital purchases (taxCode CAP), G11 — other purchases (GST-incl.)
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
  /** GST paid on this purchase, in cents (expense.taxAmountCents). Feeds 1B for UNTYPED rows. */
  gstPaidCents: number;
  /** PR 2b: AU tax code (GST/CAP/FRE/INP/NTR); null/undefined = untyped legacy row. */
  taxCode?: string | null;
  /** PR 2b: input-tax credit computed at booking. Feeds 1B for TYPED rows. */
  recoverableTaxCents?: number | null;
  /** GST-inclusive purchase amount (expense.amountCents). Feeds G10/G11. */
  grossCents?: number | null;
}

/**
 * Codes excluded from G10/G11 ("BAS excluded": outside the GST system, e.g.
 * wages, private, government fees). FRE/INP purchases DO count in G11 (ATO
 * G11 is all non-capital purchases) but give no 1B credit.
 */
const BAS_EXCLUDED_CODES = new Set(['NTR']);

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
  /** AbTenantConfig.gstRegistered. `false` → 1B is 0 (no ITCs without registration). */
  gstRegistered?: boolean | null;
  /** Employer pay stubs in the period. Omit for a GST-only BAS (no employees). */
  wages?: BasWageLine[];
}

export interface BasReturn {
  period: { start: string; end: string };
  g1TotalSalesCents: number; // GST-inclusive
  label1AGstOnSalesCents: number;
  label1BGstOnPurchasesCents: number;
  /** G10 capital purchases (GST-inclusive): typed rows coded CAP. */
  g10CapitalPurchasesCents: number;
  /** G11 non-capital purchases (GST-inclusive): other typed rows (not NTR) + all untyped rows. */
  g11NonCapitalPurchasesCents: number;
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
  let label1B = 0;
  let g10 = 0;
  let g11 = 0;
  for (const p of input.purchases) {
    const typed = p.taxCode != null && p.taxCode !== '';
    label1B += typed ? (p.recoverableTaxCents ?? 0) : p.gstPaidCents;
    const gross = p.grossCents ?? 0;
    if (typed && p.taxCode === 'CAP') g10 += gross;
    else if (!typed || !BAS_EXCLUDED_CODES.has(p.taxCode as string)) g11 += gross;
  }
  if (input.gstRegistered === false) label1B = 0;
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
    g10CapitalPurchasesCents: g10,
    g11NonCapitalPurchasesCents: g11,
    netGstCents: netGst,
    w1TotalWagesCents: w1,
    w2PaygWithheldCents: w2,
    totalPayableCents: totalPayable,
    outcome,
    counts: { salesCount: input.sales.length, purchaseCount: input.purchases.length, wageCount: wages.length },
  };
}
