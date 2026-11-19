/**
 * PurchaseView (PR 3bc.7) — one merged, date-sorted list of expenses and bills.
 *
 * Pure and dependency-free (imported by the route AND the /app client). A bill
 * appears exactly ONCE, as a bill row: paying it books no AbExpense (the
 * payment is a bill_payment journal entry), so there is no second "expense"
 * row to dedupe against — see the route's no-duplicate test.
 */
import { outstandingCents } from '@/lib/bill-amounts';

export type PurchaseBadge = 'due' | 'paid';

export interface PurchaseRow {
  kind: 'expense' | 'bill';
  id: string;
  /** ISO datetime: expense date, or bill billDate ?? createdAt. */
  date: string;
  vendor: string | null;
  /** Expense amount, or the bill TOTAL. */
  amountCents: number;
  /** Bills only: 'due' (open|partial) | 'paid'. Expenses carry null. */
  status: PurchaseBadge | null;
  /** Bills only: what is still owed (0 when paid). */
  outstandingCents?: number;
  /** Bills only: past its due date and still unpaid. */
  overdue?: boolean;
  /** Bills only: ISO due date. */
  dueDate?: string;
  /** Bills only: the supplier's invoice number, when entered. */
  billNumber?: string | null;
  /** Bills only: amount paid so far (0 for a legacy at_payment bill — never derive "paid" from it). */
  paidCents?: number;
}

/** Stored bill statuses that belong in a purchases list (cancelled / void / draft do not). */
export const PURCHASE_BILL_STATUSES = ['open', 'partial', 'paid'] as const;

interface ExpenseLike { id: string; date: Date; amountCents: number; vendor?: { name: string } | null; description?: string | null }
interface BillLike {
  id: string; vendorName: string; amountCents: number; status: string; paidCents?: number | null;
  billDate?: Date | null; createdAt: Date; dueDate: Date; deletedAt?: Date | null; postingMode?: string | null; billNumber?: string | null;
}

export function billDateOf(b: { billDate?: Date | null; createdAt: Date }): Date {
  return b.billDate ?? b.createdAt;
}

export function expenseToPurchase(e: ExpenseLike): PurchaseRow {
  return {
    kind: 'expense', id: e.id, date: e.date.toISOString(),
    vendor: e.vendor?.name ?? e.description ?? null, amountCents: e.amountCents, status: null,
  };
}

/** Today's calendar date (YYYY-MM-DD) in an IANA timezone; an invalid name falls back to UTC. */
export function todayInZone(timezone: string | null | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * `today` is the tenant's calendar date. A due date is a calendar date stored at UTC midnight, so it is
 * compared as a DATE: due today is not overdue, whatever the server clock says.
 */
export function billToPurchase(b: BillLike, today: string = todayInZone('UTC')): PurchaseRow {
  const owed = outstandingCents(b);
  const due = b.status === 'open' || b.status === 'partial';
  return {
    kind: 'bill', id: b.id, date: billDateOf(b).toISOString(), vendor: b.vendorName, amountCents: b.amountCents,
    status: due ? 'due' : 'paid', outstandingCents: owed, overdue: due && b.dueDate.toISOString().slice(0, 10) < today, dueDate: b.dueDate.toISOString(),
    billNumber: b.billNumber ?? null, paidCents: b.paidCents ?? 0,
  };
}

/** Newest first; id breaks ties so offset pages never skip or repeat a row. */
export function mergePurchases(rows: PurchaseRow[], limit: number, offset: number): PurchaseRow[] {
  return [...rows]
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.date < b.date ? 1 : -1))
    .slice(offset, offset + limit);
}
