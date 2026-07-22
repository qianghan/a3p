/**
 * Shared per-account Basiq sync logic for the business (agentbook-expense)
 * side — extracted from `apps/web-next/src/app/api/v1/agentbook-expense/bank/basiq/sync/route.ts`
 * (AU-1 Task 2) so the manual `/sync` route and the daily cron
 * (AU-1 Task 5) share exactly one implementation, mirroring how the
 * existing Plaid integration shares `syncTransactionsForAccount` between
 * its own manual-sync route and cron.
 *
 * Pure extraction — no behavior change from the originally-merged inline
 * logic. Basiq has no cursor/pagination-cap concept exposed by
 * `agentbook-basiq.ts` today, so `hasMore` is always false (nothing is
 * ever truncated).
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { listTransactions, type BasiqTransaction } from '@/lib/agentbook-basiq';
import { runMatcherOnTransaction } from '@/lib/agentbook-plaid';
import type { SyncRun } from '@/lib/plaid-sync-summary';

/**
 * Basiq's `amount` is a decimal string, negative for a debit/outflow.
 * `AbBankTransaction.amount` wants the opposite sign convention (positive
 * = debit/outflow, matching Plaid's stored rows) — negate to align. Prefer
 * the explicit `direction` field over sign-sniffing where Basiq provides it,
 * since it's an unambiguous enum rather than an inferred sign.
 */
export function basiqAmountToCents(t: Pick<BasiqTransaction, 'amount' | 'direction'>): number {
  const abs = Math.round(Math.abs(parseFloat(t.amount)) * 100);
  if (t.direction === 'debit') return abs;
  if (t.direction === 'credit') return -abs;
  return Math.round(parseFloat(t.amount) * -100);
}

/**
 * Syncs a single connected Basiq business account: pulls transactions since
 * the account's last sync, upserts `AbBankTransaction` rows (never touching
 * `category` on an existing row), runs the payment matcher on newly-created
 * rows, and stamps `lastSynced`. Returns a `SyncRun` for the caller (either
 * the manual `/sync` route, aggregating across a single tenant's accounts,
 * or the cron, aggregating across every tenant's accounts) to summarize via
 * `summarizeSyncRuns`.
 */
export async function syncBasiqAccount(
  tenantId: string,
  basiqUserId: string,
  account: { id: string; lastSynced: Date | null },
): Promise<SyncRun> {
  const txns = await listTransactions(basiqUserId, {
    since: account.lastSynced?.toISOString(),
  });

  let added = 0;
  let modified = 0;

  for (const t of txns) {
    const amount = basiqAmountToCents(t);
    const existing = await db.abBankTransaction.findUnique({
      where: { basiqTransactionId: t.id },
    });

    if (existing) {
      // `category` is intentionally NOT updated — once imported, the
      // user (or the matcher) may have refined it; a Basiq-side
      // refresh shouldn't clobber that. Amount/date/name/pending are
      // pure facts from the bank so we refresh those.
      await db.abBankTransaction.update({
        where: { id: existing.id },
        data: {
          amount,
          date: new Date(t.postDate),
          name: t.description,
          pending: t.status === 'pending',
        },
      });
      modified += 1;
    } else {
      const created = await db.abBankTransaction.create({
        data: {
          tenantId,
          bankAccountId: account.id,
          basiqTransactionId: t.id,
          amount,
          date: new Date(t.postDate),
          name: t.description,
          pending: t.status === 'pending',
          matchStatus: 'pending',
        },
      });
      added += 1;
      await runMatcherOnTransaction(tenantId, created);
    }
  }

  await db.abBankAccount.update({
    where: { id: account.id },
    data: { lastSynced: new Date() },
  });

  return { added, modified, removed: 0, hasMore: false };
}
