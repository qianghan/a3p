import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { listTransactions, sanitizeBasiqError, type BasiqTransaction } from '@/lib/agentbook-basiq';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * amountCents sign convention for AU/Basiq personal transactions.
 *
 * Basiq's own `amount` is a negative decimal string for a debit/outflow and
 * positive for a credit/inflow (confirmed in agentbook-basiq.ts's file
 * header against Basiq's live docs/examples). That is already the SAME sign
 * convention AbPersonalTransaction.amountCents uses — positive = inflow/
 * income, negative = outflow/spend (see agentbook-personal-plaid.ts's file
 * header: "Plaid: positive = outflow ... AbPersonalTransaction: positive =
 * inflow ... Negate on write").
 *
 * So, unlike the business-side Basiq sync route (Task 2 of the AU-1 plan),
 * which negates Basiq's amount to align with AbBankTransaction's OPPOSITE
 * convention (positive = outflow/debit there), THIS route must NOT negate —
 * Basiq's amount is written through unchanged in sign. Prefer the explicit
 * `direction` field over sign-sniffing `amount` when Basiq provides it, per
 * agentbook-basiq.ts's own guidance.
 */
function basiqAmountToPersonalCents(t: Pick<BasiqTransaction, 'amount' | 'direction'>): number {
  const magnitudeCents = Math.round(Math.abs(parseFloat(t.amount)) * 100);
  if (t.direction === 'debit') return -magnitudeCents;
  if (t.direction === 'credit') return magnitudeCents;
  // No explicit direction — fall back to Basiq's own amount sign, which is
  // already aligned with AbPersonalTransaction's convention (no negation).
  return Math.round(parseFloat(t.amount) * 100);
}

/**
 * Pulls new Basiq transactions for every connected AU personal account and
 * upserts them as AbPersonalTransaction rows. Mirrors the business-side
 * `agentbook-expense/bank/basiq/sync` route (AU-1 Task 2, Step 3) in shape —
 * same `since`-filtered pull, same "never overwrite category on an existing
 * row" rule — but writes to AbPersonalAccount/AbPersonalTransaction, has no
 * matcher step (personal transactions aren't reconciled against invoices/
 * expenses, matching agentbook-personal-plaid.ts's precedent), and uses the
 * inverted amount-sign convention described above.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config?.basiqUserId) {
      return NextResponse.json(
        { success: false, error: 'no Basiq user for this tenant' },
        { status: 400 },
      );
    }
    const basiqUserId = config.basiqUserId;

    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, provider: 'basiq', connected: true },
    });

    const runs: SyncRun[] = [];
    const errors: { accountId: string; error: unknown }[] = [];

    for (const account of accounts) {
      try {
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

        runs.push({ added, modified, removed: 0, hasMore: false });
        await db.abPersonalAccount.update({
          where: { id: account.id },
          data: { lastSynced: new Date() },
        });
      } catch (err) {
        console.error(
          '[agentbook-personal/bank/basiq/sync POST] account',
          account.id,
          'error:',
          err,
        );
        errors.push({ accountId: account.id, error: sanitizeBasiqError(err) });
      }
    }

    const summary = summarizeSyncRuns(runs);
    const complete = summary.complete && errors.length === 0;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'personal.basiq_sync_completed',
        actor: 'system',
        action: {
          accountsSynced: accounts.length,
          transactionsImported: summary.transactionsImported,
          modified: summary.modified,
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
    console.error('[agentbook-personal/bank/basiq/sync POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
