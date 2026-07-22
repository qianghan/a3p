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
 *
 * The per-account sync loop itself lives in `@/lib/agentbook-basiq-sync`
 * (`syncBasiqAccount`) so this route and the daily cron
 * (`agentbook/cron/basiq-sync/route.ts`, AU-1 Task 5) share exactly one
 * implementation.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { sanitizeBasiqError } from '@/lib/agentbook-basiq';
import { syncBasiqAccount } from '@/lib/agentbook-basiq-sync';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
        const run = await syncBasiqAccount(tenantId, config.basiqUserId, account);
        runs.push(run);
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
