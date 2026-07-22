/**
 * POST /api/v1/agentbook-expense/bank/basiq/sync
 *
 * Manual sync for the current tenant's connected Basiq accounts — mirrors
 * `plaid/sync/route.ts`'s shape exactly (same response contract, same
 * `AbEvent` logging, same "don't touch `category` on update" rule) but
 * pulls from Basiq's `listTransactions` instead of Plaid's cursor-based
 * `/transactions/sync`.
 *
 * Basiq has no cursor/pagination-cap concept exposed by `agentbook-basiq.ts`
 * today — each call fetches every transaction since the account's last
 * sync, so `hasMore` is always false here (nothing is ever truncated).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { runMatcherOnTransaction } from '@/lib/agentbook-plaid';
import {
  listTransactions,
  sanitizeBasiqError,
  type BasiqTransaction,
} from '@/lib/agentbook-basiq';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config?.basiqUserId) {
      return NextResponse.json(
        { success: false, error: 'no basiq user for tenant' },
        { status: 400 },
      );
    }

    const accounts = await db.abBankAccount.findMany({
      where: { tenantId, provider: 'basiq', connected: true },
    });

    const runs: SyncRun[] = [];
    const errors: { accountId: string; error: string }[] = [];

    for (const account of accounts) {
      try {
        const txns = await listTransactions(config.basiqUserId, {
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

        runs.push({ added, modified, removed: 0, hasMore: false });
      } catch (err) {
        console.error('[basiq/sync POST] account', account.id, 'error:', err);
        errors.push({ accountId: account.id, error: JSON.stringify(sanitizeBasiqError(err)) });
      }
    }

    const summary = summarizeSyncRuns(runs);
    const complete = summary.complete && errors.length === 0;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'bank.basiq_sync_completed',
        actor: 'system',
        action: {
          accountsSynced: accounts.length,
          transactionsImported: summary.transactionsImported,
          modified: summary.modified,
          removed: summary.removed,
          complete,
          errorCount: errors.length,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        accountsSynced: accounts.length,
        transactionsImported: summary.transactionsImported,
        modified: summary.modified,
        removed: summary.removed,
        complete,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[basiq/sync POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
