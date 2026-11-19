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

import { computeCaLineTax } from './tax-codes.js';

/**
 * Only the combined recoverable figure is stored, so a GST_QST row's credit is
 * apportioned GST vs QST by re-running the engine on its gross (the ratio is
 * independent of the meals fraction). Rounding remainder goes to QST.
 */
function splitGstQst(p: GstHstPurchaseLine, rec: number, input: GstHstReturnInput): { gst: number; qst: number } {
  try {
    const r = computeCaLineTax({
      jurisdiction: 'ca', region: input.region || 'QC', taxCode: 'GST_QST',
      amountCents: p.grossCents ?? 0, inclusive: true,
      registration: { gstRegistered: input.gstRegistered ?? null, qstRegistered: input.qstRegistered ?? null },
    });
    const g = r.components.find((c) => c.type === 'GST')?.recoverableCents ?? 0;
    const total = r.components.reduce((s, c) => s + c.recoverableCents, 0);
    if (total <= 0) return { gst: rec, qst: 0 };
    const gst = Math.round((rec * g) / total);
    return { gst, qst: rec - gst };
  } catch {
    return { gst: rec, qst: 0 };
  }
}

export interface GstHstSalesLine {
  /** Revenue net of GST/HST, in cents (invoice amount − its tax portion). */
  netSalesCents: number;
  /** GST/HST collected on this sale, in cents (invoice.taxCents). */
  taxCollectedCents: number;
}

export interface GstHstPurchaseLine {
  /** GST/HST paid on this purchase, in cents (expense.taxAmountCents). ITC for UNTYPED rows. */
  taxPaidCents: number;
  /** PR 2b: CA tax code; null/undefined = untyped legacy row. */
  taxCode?: string | null;
  /** PR 2b: recoverable input tax computed at booking (GST/HST + QST when QST-registered). */
  recoverableTaxCents?: number | null;
  /** Document gross (expense.amountCents) — needed to split GST_QST credits. */
  grossCents?: number | null;
}

export interface GstHstReturnInput {
  periodStart: string; // ISO date (inclusive)
  periodEnd: string; // ISO date (inclusive)
  sales: GstHstSalesLine[];
  purchases: GstHstPurchaseLine[];
  /** Province (AbTenantConfig.region) — used to split GST_QST credits. */
  region?: string | null;
  /** `false` → no ITCs/ITRs. */
  gstRegistered?: boolean | null;
  /** Only `true` reports a QST ITR. */
  qstRegistered?: boolean | null;
}

export interface GstHstReturn {
  period: { start: string; end: string };
  line101TotalSalesCents: number;
  line105GstHstCollectedCents: number;
  line108ItcCents: number;
  /** Quebec QST input tax refunds (Revenu Québec return, NOT part of line 109). */
  qstItrCents: number;
  /** 105 − 108. Positive = balance owing to CRA; negative = refund. */
  line109NetTaxCents: number;
  outcome: 'balance_owing' | 'refund' | 'nil';
  counts: { salesCount: number; purchaseCount: number };
}

export function computeGstHstReturn(input: GstHstReturnInput): GstHstReturn {
  const line101 = input.sales.reduce((s, r) => s + Math.max(0, r.netSalesCents), 0);
  const line105 = input.sales.reduce((s, r) => s + r.taxCollectedCents, 0);
  let line108 = 0;
  let qstItr = 0;
  for (const p of input.purchases) {
    const typed = p.taxCode != null && p.taxCode !== '';
    if (!typed) { line108 += p.taxPaidCents; continue; }
    const rec = p.recoverableTaxCents ?? 0;
    if (p.taxCode === 'GST_QST' && rec !== 0) {
      const { gst, qst } = splitGstQst(p, rec, input);
      line108 += gst;
      qstItr += qst;
    } else {
      line108 += rec;
    }
  }
  if (input.gstRegistered === false) { line108 = 0; qstItr = 0; }
  if (input.qstRegistered !== true) qstItr = 0;
  const line109 = line105 - line108;
  const outcome: GstHstReturn['outcome'] = line109 > 0 ? 'balance_owing' : line109 < 0 ? 'refund' : 'nil';
  return {
    period: { start: input.periodStart, end: input.periodEnd },
    line101TotalSalesCents: line101,
    line105GstHstCollectedCents: line105,
    line108ItcCents: line108,
    qstItrCents: qstItr,
    line109NetTaxCents: line109,
    outcome,
    counts: { salesCount: input.sales.length, purchaseCount: input.purchases.length },
  };
}
