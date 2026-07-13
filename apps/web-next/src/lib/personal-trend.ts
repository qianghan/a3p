/**
 * Net-worth trend reconstruction — trailing N month-end net-worth points,
 * computed from current account balances + transaction history (no
 * historical snapshot table; see the design doc for why reconstruction was
 * chosen over a snapshot cron).
 *
 * Order of operations is load-bearing and must not be reversed:
 *   1. Reconstruct each account's RAW signed balanceCents at a month-end as
 *      `account.balanceCents − Σ(that account's transactions dated strictly
 *      after the month-end)`, clamped to `0` before the account existed,
 *      skipping archived accounts. This works because the transactions POST
 *      route increments balanceCents by signed amountCents uniformly for
 *      every account regardless of asset/liability type — that uniform
 *      increment is the only reason "current balance minus later txns"
 *      reconstructs the correct historical raw balance at all.
 *   2. Only after every account's raw balance for a given month is known,
 *      apply `lib/personal-snapshot.ts`'s asset/liability aggregation
 *      (assets sum directly, liabilities sum by Math.abs) to that set of
 *      reconstructed balances — mirroring exactly how computeSnapshot()
 *      applies it to current balances for "now".
 * Applying the sign/Math.abs handling before subtracting transactions
 * (i.e. doing step 2 before step 1) produces a different, wrong answer for
 * any liability account with transactions crossing a month-end boundary.
 */

import type { AbPersonalAccount, AbPersonalTransaction } from '@naap/database';

export interface NetWorthTrendPoint {
  month: string; // "YYYY-MM"
  netWorthCents: number;
}

/** Last instant (23:59:59.999) of the month that is `monthsAgo` months before `reference`. */
function monthEnd(reference: Date, monthsAgo: number): Date {
  const end = new Date(reference.getFullYear(), reference.getMonth() - monthsAgo + 1, 1);
  end.setMilliseconds(-1);
  return end;
}

function monthLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function computeNetWorthTrend(
  accounts: AbPersonalAccount[],
  transactions: AbPersonalTransaction[],
  months = 12,
): NetWorthTrendPoint[] {
  const now = new Date();
  const activeAccounts = accounts.filter((a) => !a.archived);

  // Oldest to newest: monthsAgo = months-1 (oldest) down to 0 (current month).
  const points: NetWorthTrendPoint[] = [];
  for (let monthsAgo = months - 1; monthsAgo >= 0; monthsAgo--) {
    const end = monthEnd(now, monthsAgo);

    // Step 1 — reconstruct each account's RAW signed balance at this month-end.
    // Must complete for every account before any asset/liability handling.
    const rawBalances: { balanceCents: number; isAsset: boolean }[] = [];
    for (const account of activeAccounts) {
      if (end < account.createdAt) {
        // Clamp: account didn't exist yet at this month-end.
        rawBalances.push({ balanceCents: 0, isAsset: account.isAsset });
        continue;
      }
      const txnSumAfter = transactions
        .filter((t) => t.accountId === account.id && t.date > end)
        .reduce((sum, t) => sum + t.amountCents, 0);
      const rawBalanceCents = account.balanceCents - txnSumAfter;
      rawBalances.push({ balanceCents: rawBalanceCents, isAsset: account.isAsset });
    }

    // Step 2 — only now apply personal-snapshot.ts's asset/liability aggregation,
    // to the already-reconstructed raw balances.
    let assetsCents = 0;
    let liabilitiesCents = 0;
    for (const b of rawBalances) {
      if (b.isAsset) assetsCents += b.balanceCents;
      else liabilitiesCents += Math.abs(b.balanceCents);
    }
    const netWorthCents = assetsCents - liabilitiesCents;

    points.push({ month: monthLabel(end), netWorthCents });
  }

  return points;
}
