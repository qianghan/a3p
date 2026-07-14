/**
 * Personal Finance Plaid Sync Cron — daily fan-out across all tenants
 * with a connected AbPersonalAccount. Mirrors cron/plaid-sync/route.ts's
 * structure (the expense-side cron) — see that file for the full
 * rationale on the bounded-concurrency + timing-safe-bearer patterns,
 * duplicated here rather than imported since both are small and this
 * keeps the two Plaid integrations fully independent.
 *
 * Vercel cron: "0 6 * * *" (06:00 UTC), same slot as the expense cron.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function processAll<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
    }
  }
  return results;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = await db.abPersonalAccount.findMany({
    where: { connected: true, accessTokenEnc: { not: null } },
    select: { id: true, tenantId: true },
  });

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const tenantStats: Record<string, { added: number; errors: number }> = {};
  let errorCount = 0;

  await processAll(accounts, 5, async (acct) => {
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
      void reportError('cron/personal-plaid-sync account error', err, {
        tenantId: acct.tenantId,
        accountId: acct.id,
        sanitized: sanitizePlaidError(err),
        source: 'cron/personal-plaid-sync',
      });
    }
  });

  for (const tenantId of Object.keys(tenantStats)) {
    await db.abEvent
      .create({
        data: {
          tenantId,
          eventType: 'personal.cron_sync_completed',
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
