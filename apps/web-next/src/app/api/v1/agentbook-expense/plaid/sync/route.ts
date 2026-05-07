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
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);

    const accounts = await db.abBankAccount.findMany({
      where: { tenantId, connected: true, accessTokenEnc: { not: null } },
    });

    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;
    const errors: { accountId: string; error: string }[] = [];

    for (const account of accounts) {
      try {
        const r = await syncTransactionsForAccount(account.id);
        totalAdded += r.added;
        totalModified += r.modified;
        totalRemoved += r.removed;
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

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'bank.sync_completed',
        actor: 'system',
        action: {
          accountsSynced: accounts.length,
          transactionsImported: totalAdded,
          modified: totalModified,
          removed: totalRemoved,
          errorCount: errors.length,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        accountsSynced: accounts.length,
        transactionsImported: totalAdded,
        modified: totalModified,
        removed: totalRemoved,
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
