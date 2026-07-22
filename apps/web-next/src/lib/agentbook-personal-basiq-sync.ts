/**
 * Shared per-account Basiq sync logic for the personal-finance
 * (agentbook-personal) side — extracted from
 * `apps/web-next/src/app/api/v1/agentbook-personal/bank/basiq/sync/route.ts`
 * (AU-1 Task 4) so the manual `/sync` route and the daily cron
 * (AU-1 Task 5) share exactly one implementation. Mirrors
 * `agentbook-basiq-sync.ts`'s (business-side, Task 2) extraction pattern.
 *
 * Pure extraction — no behavior change from the originally-merged inline
 * logic. Personal transactions aren't reconciled against invoices/expenses,
 * so unlike the business side there is no matcher step here (matches
 * `agentbook-personal-plaid.ts`'s existing precedent).
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { listTransactions, type BasiqTransaction } from '@/lib/agentbook-basiq';
import type { SyncRun } from '@/lib/plaid-sync-summary';

/**
 * amountCents sign convention for AU/Basiq personal transactions.
 *
 * Basiq's own `amount` is a negative decimal string for a debit/outflow and
 * positive for a credit/inflow. That is already the SAME sign convention
 * `AbPersonalTransaction.amountCents` uses — positive = inflow/income,
 * negative = outflow/spend (see `agentbook-personal-plaid.ts`'s file header:
 * "Plaid: positive = outflow ... AbPersonalTransaction: positive = inflow
 * ... Negate on write").
 *
 * So, unlike the business-side Basiq sync (`agentbook-basiq-sync.ts`), which
 * negates Basiq's amount to align with `AbBankTransaction`'s OPPOSITE
 * convention (positive = outflow/debit there), THIS function must NOT
 * negate — Basiq's amount is written through unchanged in sign. Prefer the
 * explicit `direction` field over sign-sniffing `amount` when Basiq
 * provides it, per `agentbook-basiq.ts`'s own guidance.
 */
export function basiqAmountToPersonalCents(t: Pick<BasiqTransaction, 'amount' | 'direction'>): number {
  const magnitudeCents = Math.round(Math.abs(parseFloat(t.amount)) * 100);
  if (t.direction === 'debit') return -magnitudeCents;
  if (t.direction === 'credit') return magnitudeCents;
  // No explicit direction — fall back to Basiq's own amount sign, which is
  // already aligned with AbPersonalTransaction's convention (no negation).
  return Math.round(parseFloat(t.amount) * 100);
}

/**
 * Syncs a single connected Basiq personal account: pulls transactions since
 * the account's last sync, upserts `AbPersonalTransaction` rows (never
 * touching `category` on an existing row), and stamps `lastSynced`. Returns
 * a `SyncRun` for the caller (either the manual `/sync` route or the cron)
 * to summarize via `summarizeSyncRuns`.
 */
export async function syncPersonalBasiqAccount(
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
    const amountCents = basiqAmountToPersonalCents(t);
    const existing = await db.abPersonalTransaction.findUnique({
      where: { basiqTransactionId: t.id },
    });
    await db.abPersonalTransaction.upsert({
      where: { basiqTransactionId: t.id },
      create: {
        tenantId,
        accountId: account.id,
        basiqTransactionId: t.id,
        amountCents,
        date: new Date(t.postDate),
        description: t.description || 'Unknown',
        category: 'uncategorized',
        pending: t.status === 'pending',
        idempotencyKey: t.id,
      },
      // category intentionally not touched on update — same rule as
      // the business-side Basiq sync and personal-Plaid sync: a
      // Basiq-side modify shouldn't clobber a user's re-categorization.
      update: {
        amountCents,
        date: new Date(t.postDate),
        description: t.description || 'Unknown',
        pending: t.status === 'pending',
      },
    });
    if (existing) modified += 1;
    else added += 1;
  }

  await db.abPersonalAccount.update({
    where: { id: account.id },
    data: { lastSynced: new Date() },
  });

  return { added, modified, removed: 0, hasMore: false };
}
