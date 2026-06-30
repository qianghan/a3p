/**
 * POST /api/v1/agentbook-expense/plaid/sync
 *
 * Manual sync for the current tenant — pulls new transactions from
 * Plaid for every connected bank account and runs the matcher. Same
 * code path as the daily cron, just without the per-tenant fan-out.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-plaid';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const accounts = await db.abBankAccount.findMany({
      where: { tenantId, connected: true, accessTokenEnc: { not: null } },
    });

    const runs: SyncRun[] = [];
    const errors: { accountId: string; error: string }[] = [];

    for (const account of accounts) {
      try {
        const r = await syncTransactionsForAccount(account.id);
        runs.push({ added: r.added, modified: r.modified, removed: r.removed, hasMore: r.hasMore });
      } catch (err) {
        // Log full error server-side; only surface a sanitized string
        // (Plaid axios errors can leak the access token via err.config).
        console.error('[plaid/sync POST] account', account.id, 'error:', err);
        errors.push({
          accountId: account.id,
          error: sanitizePlaidError(err),
        });
      }
    }

    const summary = summarizeSyncRuns(runs);
    // A failed account leaves its history un-pulled, so the backfill is only
    // truly complete when every account drained AND none errored. Clients can
    // re-POST while `complete` is false to finish a first-time history import.
    const complete = summary.complete && errors.length === 0;

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'bank.sync_completed',
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
    console.error('[plaid/sync POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
