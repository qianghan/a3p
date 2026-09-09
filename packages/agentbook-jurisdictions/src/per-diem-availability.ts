/**
 * Why per-diem is a US-only feature, and what to tell everyone else.
 *
 * This started as a gap on the launch scorecard — "AU: no per-diem" — read as
 * a missing table someone should go and build. It is the opposite. A per-diem
 * is a SUBSTANTIATION SHORTCUT: it lets you deduct a daily amount for meals
 * without keeping receipts. Whether one exists for you is not a question about
 * rate tables, it is a question about who your revenue authority lets off the
 * hook for record-keeping, and the answer for a self-employed person is
 * usually nobody.
 *
 *   US   The IRS lets a self-employed taxpayer use the federal M&IE rate in
 *        place of actual meal costs. Lodging per-diem is employees only, which
 *        the existing implementation already handles by making lodging opt-in.
 *
 *   AU   The ATO's "reasonable amounts" (the annual TD determination) remove
 *        the need for written evidence only for an EMPLOYEE who received a
 *        bona fide travel allowance. A sole trader does not pay themselves an
 *        allowance, so the exception never applies: actual costs, with tax
 *        invoices. Six or more consecutive nights also needs a travel diary.
 *
 *   CA   The CRA's simplified meal method is for transport employees and for
 *        moving/medical travel. A self-employed person deducts 50% of actual
 *        meal and entertainment costs, with receipts.
 *
 *   UK   HMRC benchmark scale rates are for reimbursing employees. The
 *        self-employed claim actual subsistence costs; the simplified-expenses
 *        flat rates cover vehicles and working from home, not meals.
 *
 * So building an AU table would not close a gap — it would invite a sole
 * trader to claim meals without the receipts the ATO requires, and hand them
 * an audit problem the product created. Saying so plainly is the feature.
 */

export interface PerDiemAvailability {
  available: boolean;
  /** User-facing explanation. Present whenever `available` is false. */
  message: string | null;
}

const UNAVAILABLE: Record<string, string> = {
  au: "Australia doesn't have a per-diem you can use. The ATO's reasonable travel amounts let you skip receipts only if you're an employee who received a travel allowance — as a sole trader you're not paying yourself one, so you claim what you actually spent and keep the tax invoices. Log the meals and accommodation as expenses and snap the receipts; I'll categorise them. If a trip runs six or more consecutive nights, the ATO also wants a travel diary.",
  ca: "Canada doesn't have a per-diem you can use. The CRA's simplified meal method is for transport employees and for moving or medical travel, not for self-employed business travel — you deduct 50% of what you actually spent on meals, with receipts. Log them as expenses and I'll apply the 50% limit.",
  uk: "The UK doesn't have a per-diem you can use. HMRC's benchmark scale rates are for reimbursing employees; if you're self-employed you claim your actual subsistence costs, and the simplified-expenses flat rates only cover vehicles and working from home. Log the meals as expenses with receipts.",
};

/**
 * Whether the per-diem method is available to a self-employed taxpayer here.
 *
 * An unknown jurisdiction is treated as unavailable rather than assumed to
 * work like the US — a wrong "yes" here is a deduction the user cannot
 * substantiate.
 */
export function perDiemAvailability(jurisdiction: string | null | undefined): PerDiemAvailability {
  const j = (jurisdiction || '').trim().toLowerCase();
  if (j === 'us') return { available: true, message: null };
  const message = UNAVAILABLE[j];
  return {
    available: false,
    message: message
      ?? "Per-diem is a US federal method — the IRS lets a self-employed taxpayer use a daily meal rate instead of actual costs. Your tax authority doesn't offer an equivalent for the self-employed, so log meals and accommodation as expenses with receipts instead.",
  };
}
