/**
 * Balance-sheet accrual helpers.
 *
 * The books are kept on a single accrual ledger. Invoices already post
 * Accounts Receivable (Dr 1100 / Cr Revenue) on creation, so A/R is reflected
 * in the asset accounts and needs no derivation here.
 *
 * Open A/P is the gap: AbBill only posts to the ledger when *paid*
 * (Dr expense / Cr cash), so an unpaid bill never appears as a liability.
 * Under accrual basis the balance sheet should recognize those open bills as
 * Accounts Payable (with an offsetting reduction in retained earnings, since
 * the expense has been incurred). This pure helper sums them so the route can
 * add a single A/P line and keep the sheet balanced.
 */

export interface BillLike {
  status: string;
  amountCents: number;
}

/** Sum of bills still owed (status === 'open'). Paid/cancelled are excluded. */
export function sumOpenBills(bills: BillLike[]): number {
  return bills.reduce((sum, bill) => (bill.status === 'open' ? sum + (bill.amountCents || 0) : sum), 0);
}
