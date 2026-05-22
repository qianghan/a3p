import { prisma } from '@naap/database';
import { resolveAccountId } from './account-resolver.js';
import { getCurrentPlanStrict, getCurrentPlan } from './plans.js';
import type { UsageDimension } from './types.js';

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  limit: number;     // -1 = unlimited
  remaining: number; // Infinity when unlimited
  /**
   * Reason code for a denial. Only populated when allowed === false.
   *   • 'quota_exceeded'           — used >= limit (normal denial; HTTP 402)
   *   • 'quota_check_unavailable'  — DB error during the check (HTTP 503)
   */
  reason?: 'quota_exceeded' | 'quota_check_unavailable';
  /**
   * True when the denial is transient (DB error) — caller should
   * surface this as a 503 / retry, not a 402 upgrade nudge.
   */
  retryable?: boolean;
}

function periodStartOf(d: Date | null): Date {
  if (d) return d;
  // Free tier with no current period: bucket by calendar month start UTC
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function checkQuota(tenantId: string, dim: UsageDimension): Promise<QuotaCheck> {
  try {
    const cur = await getCurrentPlanStrict(tenantId);
    const limit = cur.plan.quotas[dim];
    const used = cur.usage[dim].used;
    if (limit === -1) {
      return { allowed: true, used, limit: -1, remaining: Number.POSITIVE_INFINITY };
    }
    const allowed = used < limit;
    return {
      allowed,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      ...(allowed ? {} : { reason: 'quota_exceeded' as const }),
    };
  } catch (err) {
    // Fail CLOSED on DB errors (G-022). Previously this returned
    // { allowed: true } and the billing layer was effectively decorative
    // for free-tier users whenever Postgres hiccuped. We now deny the
    // request and mark it retryable so the HTTP caller can return 503
    // (not 402) — the user retries rather than being walled off.
    console.error('[billing] checkQuota failed, denying request (fail-closed):', err);
    return {
      allowed: false,
      used: 0,
      limit: 0,
      remaining: 0,
      reason: 'quota_check_unavailable',
      retryable: true,
    };
  }
}

export async function incrementUsage(tenantId: string, dim: UsageDimension, n: number = 1): Promise<void> {
  try {
    const accountId = await resolveAccountId(tenantId);
    const cur = await getCurrentPlan(tenantId);
    const periodStart = periodStartOf(
      cur.periodEnd ? new Date(cur.periodEnd.getTime() - 30 * 86400_000) : null,
    );
    await prisma.billUsageCounter.upsert({
      where: { accountId_dimension_periodStart: { accountId, dimension: dim, periodStart } },
      create: { accountId, dimension: dim, periodStart, count: n },
      update: { count: { increment: n } },
    });
  } catch (err) {
    console.warn('[billing] incrementUsage swallowed error:', err);
  }
}

export async function getUsage(tenantId: string, dim: UsageDimension): Promise<number> {
  try {
    const cur = await getCurrentPlan(tenantId);
    return cur.usage[dim].used;
  } catch (err) {
    console.warn('[billing] getUsage failed:', err);
    return 0;
  }
}
