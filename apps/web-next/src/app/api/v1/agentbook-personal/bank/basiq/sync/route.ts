import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { sanitizeBasiqError } from '@/lib/agentbook-basiq';
import { syncPersonalBasiqAccount } from '@/lib/agentbook-personal-basiq-sync';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Pulls new Basiq transactions for every connected AU personal account and
 * upserts them as AbPersonalTransaction rows. Mirrors the business-side
 * `agentbook-expense/bank/basiq/sync` route (AU-1 Task 2, Step 3) in shape —
 * same `since`-filtered pull, same "never overwrite category on an existing
 * row" rule — but writes to AbPersonalAccount/AbPersonalTransaction, has no
 * matcher step (personal transactions aren't reconciled against invoices/
 * expenses, matching agentbook-personal-plaid.ts's precedent), and uses the
 * inverted amount-sign convention documented in `agentbook-personal-basiq-sync.ts`.
 *
 * The per-account sync loop itself lives in `@/lib/agentbook-personal-basiq-sync`
 * (`syncPersonalBasiqAccount`) so this route and the daily cron
 * (`agentbook/cron/personal-basiq-sync/route.ts`, AU-1 Task 5) share exactly
 * one implementation.
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
        const run = await syncPersonalBasiqAccount(tenantId, basiqUserId, account);
        runs.push(run);
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
