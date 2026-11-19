/**
 * Bill amounts — the ONE definition of "unpaid" and "outstanding" for AbBill
 * (spec §5.2, PR 3bc.5). Pure, dependency-free: imported by the Next readers
 * through `apps/web-next/src/lib/bill-amounts.ts` and by the chat skills in
 * server.ts directly.
 *
 *   unpaid      = status in (open, partial) AND deletedAt IS NULL
 *   outstanding = open    → amountCents (status is authoritative: legacy
 *                           at_payment rows never maintained paidCents)
 *                 partial → amountCents − paidCents
 *                 else    → 0 (paid / cancelled / draft / deleted)
 *
 * Never derive "paid" from paidCents: a legacy at_payment bill is status
 * 'paid' with paidCents 0.
 */

export const UNPAID_BILL_STATUSES = ['open', 'partial'] as const;

export interface BillAmountLike {
  status: string;
  amountCents: number;
  paidCents?: number | null;
  deletedAt?: Date | string | null;
  postingMode?: string | null;
}

/** Where-fragment: a bill that still exists (soft delete). */
export function liveBillWhere() {
  return { deletedAt: null } as const;
}

/** Where-fragment: a live bill that is still owed (open or partially paid). */
export function unpaidBillWhere() {
  return { status: { in: [...UNPAID_BILL_STATUSES] }, deletedAt: null };
}

export function isUnpaid(bill: BillAmountLike): boolean {
  return (bill.status === 'open' || bill.status === 'partial') && !bill.deletedAt;
}

export function outstandingCents(bill: BillAmountLike): number {
  if (!isUnpaid(bill)) return 0;
  const total = bill.amountCents || 0;
  if (bill.status === 'open') return total;
  return Math.max(0, total - (bill.paidCents || 0));
}

export function sumOutstanding(bills: BillAmountLike[]): number {
  return bills.reduce((s, b) => s + outstandingCents(b), 0);
}

/**
 * Accounts payable the ledger does NOT already carry: unpaid `at_payment`
 * bills (they post only when paid). `at_entry` bills are already credited to
 * journal account 2000 on their billDate, so counting them here would count
 * them twice.
 */
export function derivedPayableCents(bills: BillAmountLike[]): number {
  return bills.reduce((s, b) => (b.postingMode === 'at_entry' ? s : s + outstandingCents(b)), 0);
}

/** Totals the chat skills / reviews quote: what is owed, and what is overdue. */
export function summarizeUnpaidBills<B extends BillAmountLike & { dueDate: Date }>(bills: B[], now: Date) {
  const unpaid = bills.filter(isUnpaid);
  const overdue = unpaid.filter((b) => b.dueDate < now);
  return {
    unpaid,
    overdue,
    openCents: sumOutstanding(unpaid),
    overdueCents: sumOutstanding(overdue),
  };
}

/** The unpaid bills of a tenant, due-date order — the chat skills' one query. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadUnpaidBills(db: any, tenantId: string) {
  return db.abBill.findMany({ where: { tenantId, ...unpaidBillWhere() }, orderBy: { dueDate: 'asc' } });
}
