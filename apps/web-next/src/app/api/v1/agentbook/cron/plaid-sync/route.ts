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
 *
 * NOTE: the timing-safe bearer comparison below is currently only on
 * this cron. The other AgentBook crons (morning-digest, recurring-invoices,
 * etc.) still use a string-equals compare. We should retrofit those in a
 * follow-up — leaving them out of this PR to keep the diff focused.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { syncTransactionsForAccount, sanitizePlaidError } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Constant-time bearer-token comparison. Comparing length first is fine
 * (length is not a secret) and lets us skip allocating equal-sized buffers
 * just to short-circuit. We always allocate before comparing so a same-length
 * mismatch still takes constant time relative to the string contents.
 */
function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Run `fn` over `items` with at most `n` concurrent in-flight calls.
 * Failures are caught inside `fn` (and logged); this helper drops rejected
 * settlements so a single bad account doesn't sink the whole batch.
 */
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
      // Failures are logged inside fn; don't fail the whole batch.
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

  const accounts = await db.abBankAccount.findMany({
    where: { connected: true, accessTokenEnc: { not: null } },
    select: { id: true, tenantId: true },
  });

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const tenantStats: Record<string, { added: number; errors: number }> = {};
  let errorCount = 0;

  // Bounded fan-out: cap at 5 concurrent syncs to avoid hammering Plaid
  // and to stay under their rate limits when many tenants are connected.
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
      // Full error server-side, sanitized string in any structured fields.
      console.error(
        '[cron/plaid-sync] account',
        acct.id,
        'tenant',
        acct.tenantId,
        'error:',
        err,
        'sanitized:',
        sanitizePlaidError(err),
      );
    }
  });

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
