/**
 * Plaid Sync Cron — daily fan-out across all tenants with a connected
 * bank account. For each connected `AbBankAccount`, calls Plaid
 * `/transactions/sync` with the stored `cursorToken`, upserts
 * `AbBankTransaction` rows, and runs the matcher.
 *
 * Vercel cron: "0 6 * * *" (06:00 UTC). Idempotent — Plaid's cursor
 * model means re-running with the same cursor returns nothing new.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}` if the env var
 * is set (mirrors the morning-digest / recurring-invoices crons).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { syncTransactionsForAccount } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = await db.abBankAccount.findMany({
    where: { connected: true, accessTokenEnc: { not: null } },
    select: { id: true, tenantId: true },
  });

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const tenantStats: Record<string, { added: number; errors: number }> = {};
  let errorCount = 0;

  for (const acct of accounts) {
    try {
      const r = await syncTransactionsForAccount(acct.id);
      totalAdded += r.added;
      totalModified += r.modified;
      totalRemoved += r.removed;
      const t = (tenantStats[acct.tenantId] ??= { added: 0, errors: 0 });
      t.added += r.added;
    } catch (err) {
      errorCount++;
      const t = (tenantStats[acct.tenantId] ??= { added: 0, errors: 0 });
      t.errors++;
      console.error(
        '[cron/plaid-sync] account',
        acct.id,
        'tenant',
        acct.tenantId,
        'error:',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // Per-tenant audit event so a user looking at their event log sees
  // when overnight sync ran.
  for (const tenantId of Object.keys(tenantStats)) {
    await db.abEvent
      .create({
        data: {
          tenantId,
          eventType: 'bank.cron_sync_completed',
          actor: 'system',
          action: tenantStats[tenantId],
        },
      })
      .catch(() => null);
  }

  return NextResponse.json({
    ok: true,
    accountsProcessed: accounts.length,
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
    errorCount,
    timestamp: new Date().toISOString(),
  });
}
