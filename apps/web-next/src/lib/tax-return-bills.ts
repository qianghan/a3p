/**
 * Bills on the indirect-tax returns (PR 3bc.6) — AU BAS (1B/G10/G11) and the
 * CA GST/HST return (line 108). Bills are NOT expenses: payBill never creates
 * an AbExpense, so the expense rows the returns already count never overlap
 * these purchase lines.
 *
 * Basis = AbTenantConfig.gstReportingBasis ('cash' | anything else = accrual).
 *
 *   accrual  every live, non-void bill counts in full on billDate (legacy rows
 *            with no billDate: createdAt).
 *   cash     a bill counts on each non-voided AbBillPayment.date, pro-rata by
 *            payment.amountCents / bill.amountCents, applied per line to the
 *            recoverable tax, the paid tax and the gross. Rounding is
 *            CUMULATIVE: payment k gets round(x·cumAfter/T) − round(x·cumBefore/T)
 *            (payments ordered by date, createdAt, id), so the final payment
 *            takes the remainder and a fully paid bill sums to its exact totals.
 *            Legacy at_payment bills that are 'paid' with no payment rows count
 *            100% on paidDate, else the date of their payment journal entry
 *            (bill.journalEntryId), else — not inferable — on accrual dating.
 *
 * A bill without AbBillLine rows (legacy) is one UNTYPED line: gross =
 * amountCents, tax paid = taxCents ?? 0 (same treatment as an untyped expense).
 *
 * Date filtering is done here in JS as well as in the query, so the window
 * rules are the tested ones (the query only narrows the read).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export type GstBasis = 'accrual' | 'cash';

export interface BillPurchaseLine {
  taxCode: string | null;
  /** Typed rows: the ITC computed at entry. */
  recoverableTaxCents: number;
  /** Untyped rows: the printed tax paid. */
  taxPaidCents: number;
  /** GST-inclusive gross. */
  grossCents: number;
  categoryId: string | null;
}

export function gstBasisOf(cfg: { gstReportingBasis?: string | null } | null | undefined): GstBasis {
  return cfg?.gstReportingBasis === 'cash' ? 'cash' : 'accrual';
}

const EXCLUDED_STATUSES = ['cancelled', 'draft'];

function counts(bill: Row): boolean {
  return !bill.deletedAt && !EXCLUDED_STATUSES.includes(bill.status);
}

function linesOf(bill: Row): BillPurchaseLine[] {
  const lines: Row[] = Array.isArray(bill.lines) ? bill.lines : [];
  if (lines.length === 0) {
    return [{ taxCode: null, recoverableTaxCents: 0, taxPaidCents: bill.taxCents ?? 0, grossCents: bill.amountCents, categoryId: null }];
  }
  return lines.map((l) => ({
    taxCode: l.taxCode ?? null,
    recoverableTaxCents: l.recoverableTaxCents ?? 0,
    taxPaidCents: l.taxCents ?? 0,
    grossCents: l.amountCents,
    categoryId: l.categoryId ?? null,
  }));
}

const inWindow = (d: Date | null | undefined, gte: Date, lte: Date) =>
  !!d && d.getTime() >= gte.getTime() && d.getTime() <= lte.getTime();

/** The share of x carried by a payment covering cumBefore → cumAfter of total. */
export function proRataShare(x: number, cumBefore: number, cumAfter: number, total: number): number {
  if (total <= 0) return 0;
  const after = Math.min(cumAfter, total);
  const before = Math.min(cumBefore, total);
  return Math.round((x * after) / total) - Math.round((x * before) / total);
}

const livePayments = (bill: Row): Row[] =>
  (Array.isArray(bill.payments) ? bill.payments : [])
    .filter((p: Row) => !p.voidedAt)
    .sort((a: Row, b: Row) =>
      (a.date as Date).getTime() - (b.date as Date).getTime() ||
      ((a.createdAt as Date | undefined)?.getTime() ?? 0) - ((b.createdAt as Date | undefined)?.getTime() ?? 0) ||
      String(a.id).localeCompare(String(b.id)));

/**
 * Pure: bills (with embedded `lines` and `payments`) → the purchase lines that
 * fall in [gte, lte] on the given basis. `journalDates` maps a legacy bill's
 * journalEntryId to its entry date (cash basis only).
 */
export function billPurchasesInPeriod(
  bills: Row[],
  opts: { basis: GstBasis; gte: Date; lte: Date; journalDates?: Map<string, Date> },
): BillPurchaseLine[] {
  const out: BillPurchaseLine[] = [];
  for (const bill of bills) {
    if (!counts(bill)) continue;
    const accrualDate: Date = bill.billDate ?? bill.createdAt;
    const lines = linesOf(bill);
    if (opts.basis === 'accrual') {
      if (inWindow(accrualDate, opts.gte, opts.lte)) out.push(...lines);
      continue;
    }
    const payments = livePayments(bill);
    if (payments.length === 0) {
      if (bill.status !== 'paid') continue; // nothing paid yet → nothing on cash basis
      const paidOn: Date =
        bill.paidDate ?? (bill.journalEntryId ? opts.journalDates?.get(bill.journalEntryId) : undefined) ?? accrualDate;
      if (inWindow(paidOn, opts.gte, opts.lte)) out.push(...lines);
      continue;
    }
    const total = bill.amountCents as number;
    let cum = 0;
    for (const p of payments) {
      const before = cum;
      cum += p.amountCents as number;
      if (!inWindow(p.date, opts.gte, opts.lte)) continue;
      for (const l of lines) {
        out.push({
          taxCode: l.taxCode,
          categoryId: l.categoryId,
          recoverableTaxCents: proRataShare(l.recoverableTaxCents, before, cum, total),
          taxPaidCents: proRataShare(l.taxPaidCents, before, cum, total),
          grossCents: proRataShare(l.grossCents, before, cum, total),
        });
      }
    }
  }
  return out;
}

/** Reads the bills that can fall in the window and returns their purchase lines. */
export async function loadBillPurchases(
  db: any,
  tenantId: string,
  gte: Date,
  lte: Date,
  basis: GstBasis,
): Promise<BillPurchaseLine[]> {
  const base = { tenantId, deletedAt: null, status: { notIn: EXCLUDED_STATUSES } };
  const window = { gte, lte };
  const where =
    basis === 'accrual'
      ? { ...base, OR: [{ billDate: window }, { billDate: null, createdAt: window }] }
      : {
          ...base,
          OR: [
            { payments: { some: { voidedAt: null, date: window } } },
            { status: 'paid', payments: { none: { voidedAt: null } } },
          ],
        };
  const bills: Row[] = await db.abBill.findMany({
    where,
    include: { lines: true, payments: { where: { voidedAt: null } } },
  });
  let journalDates: Map<string, Date> | undefined;
  if (basis === 'cash') {
    const ids = bills
      .filter((b) => !b.paidDate && b.journalEntryId && livePayments(b).length === 0)
      .map((b) => b.journalEntryId as string);
    if (ids.length > 0) {
      const entries: Row[] = await db.abJournalEntry.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, date: true } });
      journalDates = new Map(entries.map((e) => [e.id as string, e.date as Date]));
    }
  }
  return billPurchasesInPeriod(bills, { basis, gte, lte, journalDates });
}
