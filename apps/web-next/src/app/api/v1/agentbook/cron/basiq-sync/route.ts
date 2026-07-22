/**
 * Basiq Sync Cron — daily fan-out across all AU tenants with a connected
 * Basiq business account. Mirrors `cron/plaid-sync/route.ts`'s structure
 * exactly (bounded-concurrency batching, timing-safe bearer auth,
 * per-tenant `AbEvent` audit row) — duplicated here rather than imported
 * since both are small and this keeps the Plaid and Basiq integrations
 * fully independent, matching the existing precedent between
 * `cron/plaid-sync` and `cron/personal-plaid-sync`.
 *
 * For each connected `AbBankAccount` with `provider: 'basiq'`, calls the
 * shared `syncBasiqAccount` (extracted from the manual `/sync` route in
 * this same PR, AU-1 Task 5 Step 1) so the cron and the manual route share
 * exactly one implementation.
 *
 * Vercel cron: "15 6 * * *" (06:15 UTC) — offset 15 minutes after the
 * existing Plaid cron's "0 6 * * *" so all four bank-sync crons (Plaid
 * business/personal, Basiq business/personal) don't fire in the same
 * minute.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}` if the env var
 * is set (mirrors the Plaid crons).
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { syncBasiqAccount } from '@/lib/agentbook-basiq-sync';
import { sanitizeBasiqError } from '@/lib/agentbook-basiq';
import { summarizeSyncRuns, type SyncRun } from '@/lib/plaid-sync-summary';
import { reportError } from '@/lib/logger';

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
    where: { provider: 'basiq', connected: true },
    select: { id: true, tenantId: true, lastSynced: true },
  });

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const tenantStats: Record<string, { added: number; errors: number }> = {};
  let errorCount = 0;
  const runs: SyncRun[] = [];

  // basiqUserId is tenant-level (stored on AbTenantConfig, not on the
  // account row like Plaid's accessTokenEnc), so cache it per tenant to
  // avoid a redundant lookup for every account belonging to the same
  // tenant within a batch.
  const basiqUserIdCache = new Map<string, string | null>();
  async function getBasiqUserId(tenantId: string): Promise<string | null> {
    if (basiqUserIdCache.has(tenantId)) return basiqUserIdCache.get(tenantId) ?? null;
    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const id = config?.basiqUserId ?? null;
    basiqUserIdCache.set(tenantId, id);
    return id;
  }

  // Bounded fan-out: cap at 5 concurrent syncs to avoid hammering Basiq
  // and to stay under their rate limits when many tenants are connected.
  await processAll(accounts, 5, async (acct) => {
    try {
      const basiqUserId = await getBasiqUserId(acct.tenantId);
      if (!basiqUserId) {
        throw new Error(`no basiq user for tenant ${acct.tenantId}`);
      }
      const r = await syncBasiqAccount(acct.tenantId, basiqUserId, acct);
      runs.push(r);
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
      void reportError('cron/basiq-sync account error', err, {
        tenantId: acct.tenantId,
        accountId: acct.id,
        sanitized: sanitizeBasiqError(err),
        source: 'cron/basiq-sync',
      });
    }
  });

  // Per-tenant audit event so a user looking at their event log sees
  // when overnight sync ran. Same shape as `bank.cron_sync_completed`.
  for (const tenantId of Object.keys(tenantStats)) {
    await db.abEvent
      .create({
        data: {
          tenantId,
          eventType: 'bank.basiq_cron_sync_completed',
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
    summary: summarizeSyncRuns(runs),
    timestamp: new Date().toISOString(),
  });
}
