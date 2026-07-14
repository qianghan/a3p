import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, connected: true, accessTokenEnc: { not: null } },
    });

    const runs: SyncRun[] = [];
    const errors: { accountId: string; error: string }[] = [];

    for (const account of accounts) {
      try {
        const r = await syncTransactionsForAccount(account.id);
        runs.push({ added: r.added, modified: r.modified, removed: r.removed, hasMore: r.hasMore });
      } catch (err) {
        console.error('[agentbook-personal/plaid/sync POST] account', account.id, 'error:', err);
        errors.push({ accountId: account.id, error: sanitizePlaidError(err) });
      }
    }

    const summary = summarizeSyncRuns(runs);
    const complete = summary.complete && errors.length === 0;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'personal.bank_sync_completed',
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
    console.error('[agentbook-personal/plaid/sync POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
