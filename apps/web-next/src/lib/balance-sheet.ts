/**
 * Balance-sheet accrual helpers.
 *
 * Invoices post A/R on creation, so A/R is in the asset accounts already.
 *
 * Accounts payable has two sources (PR 3bc.5, spec §5.2):
 *   - `at_entry` bills post DR expense / CR 2000 on their billDate, so their
 *     A/P is in journal account 2000 and their expense is in retained
 *     earnings already. Nothing is derived for them.
 *   - `at_payment` bills (every legacy row) only post when paid
 *     (DR expense / CR cash). Under accrual their OUTSTANDING amount is
 *     recognised as derived A/P with an equal reduction of retained earnings,
 *     dated by createdAt (owner call O5 — legacy dating unchanged).
 * The derived amount is merged into the 2000 line so a bill is never shown
 * (or counted) twice.
 */
import { derivedPayableCents, type BillAmountLike } from '@/lib/bill-amounts';

export interface BillLike extends BillAmountLike {}

/** Derived (non-ledger) A/P: outstanding of unpaid at_payment bills only. */
export function sumOpenBills(bills: BillLike[]): number {
  return derivedPayableCents(bills);
}

export interface AccountTotals {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  debitCents: number;
  creditCents: number;
}

export interface BsLine {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  balanceCents: number;
}

export const AP_CODE = '2000';

/**
 * Pure balance-sheet computation. `accounts` carries the journal totals of
 * every active account (all five types) as of the date; `bills` the bills
 * created on/before it (only read under accrual).
 */
export function computeBalanceSheet(accounts: AccountTotals[], bills: BillLike[], basis: 'cash' | 'accrual') {
  const lines: BsLine[] = [];
  for (const a of accounts) {
    if (!['asset', 'liability', 'equity'].includes(a.accountType)) continue;
    const balance = a.accountType === 'asset' ? a.debitCents - a.creditCents : a.creditCents - a.debitCents;
    if (balance !== 0) {
      lines.push({ accountId: a.accountId, code: a.code, name: a.name, accountType: a.accountType, balanceCents: balance });
    }
  }
  const assets = lines.filter((l) => l.accountType === 'asset');
  const liabilities = lines.filter((l) => l.accountType === 'liability');
  const equity = lines.filter((l) => l.accountType === 'equity');

  const accruedPayableCents = basis === 'accrual' ? sumOpenBills(bills) : 0;
  if (accruedPayableCents > 0) {
    const ap = liabilities.find((l) => l.code === AP_CODE);
    if (ap) ap.balanceCents += accruedPayableCents;
    else {
      liabilities.push({
        accountId: 'derived:accounts-payable',
        code: AP_CODE,
        name: 'Accounts Payable (open bills)',
        accountType: 'liability',
        balanceCents: accruedPayableCents,
      });
    }
  }

  const net = (type: string, sign: 1 | -1) =>
    accounts.filter((a) => a.accountType === type).reduce((s, a) => s + sign * (a.creditCents - a.debitCents), 0);
  const retainedEarningsCents = net('revenue', 1) - net('expense', -1) - accruedPayableCents;

  const totalAssetsCents = assets.reduce((s, l) => s + l.balanceCents, 0);
  const totalLiabilitiesCents = liabilities.reduce((s, l) => s + l.balanceCents, 0);
  const totalEquityCents = equity.reduce((s, l) => s + l.balanceCents, 0) + retainedEarningsCents;
  return {
    assets,
    liabilities,
    equity,
    retainedEarningsCents,
    accountsPayableOpenCents: accruedPayableCents,
    totalAssetsCents,
    totalLiabilitiesCents,
    totalEquityCents,
    balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents,
  };
}
