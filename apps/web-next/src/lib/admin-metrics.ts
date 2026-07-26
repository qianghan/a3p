import 'server-only';
import { prisma as db } from '@naap/database';

/**
 * Platform-wide metrics for the admin overview dashboard. All values are
 * computed from existing data — no new tables:
 *   - users/signups: User.createdAt
 *   - revenue/conversion: BillSubscription (status='active') × BillPlan.priceCents,
 *     counting only billingSource='stripe' as real revenue (manual = comped rep plans)
 *   - reps: SalesRepProfile + SalesRepCommissionAccrual + SalesRepPayout
 */

export interface PlatformMetrics {
  users: { total: number; new7d: number; new30d: number };
  signupTrend: { month: string; count: number }[]; // last 6 months, oldest→newest
  revenue: {
    mrrCents: number;
    arrCents: number;
    payingCount: number;
    conversionRate: number; // paying / total users, 0..1
    planDistribution: { code: string; name: string; count: number; monthlyCents: number }[];
  };
  reps: {
    active: number;
    commissionsAllTimeCents: number;
    pendingPayoutCents: number;
    top: { tenantId: string; email: string | null; commissionCents: number }[];
  };
}

/** Normalize a plan's price to a monthly figure so annual and monthly plans sum correctly. */
function monthlyEquivalent(priceCents: number, interval: string): number {
  if (interval === 'year') return Math.round(priceCents / 12);
  return priceCents;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function computePlatformMetrics(now: Date = new Date()): Promise<PlatformMetrics> {
  const d7 = new Date(now.getTime() - 7 * 864e5);
  const d30 = new Date(now.getTime() - 30 * 864e5);
  // Start of the month 5 months ago (→ 6 buckets incl. current).
  const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

  const [totalUsers, new7d, new30d, trendUsers, activeSubs, activeReps, accruals, pendingPayouts] =
    await Promise.all([
      db.user.count(),
      db.user.count({ where: { createdAt: { gte: d7 } } }),
      db.user.count({ where: { createdAt: { gte: d30 } } }),
      db.user.findMany({ where: { createdAt: { gte: trendStart } }, select: { createdAt: true } }),
      db.billSubscription.findMany({
        where: { status: 'active' },
        select: { billingSource: true, plan: { select: { code: true, name: true, priceCents: true, interval: true } } },
      }),
      db.salesRepProfile.count({ where: { status: 'active' } }),
      db.salesRepCommissionAccrual.findMany({ where: { reversedAt: null }, select: { salesRepId: true, commissionCents: true } }),
      db.salesRepPayout.findMany({ where: { status: { in: ['submitted', 'approved'] } }, select: { totalCents: true } }),
    ]);

  // Signup trend — 6 month buckets.
  const buckets: { month: string; count: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
    buckets.push({ month: monthKey(m), count: 0 });
  }
  const bucketIdx = new Map(buckets.map((b, i) => [b.month, i]));
  for (const u of trendUsers) {
    const idx = bucketIdx.get(monthKey(new Date(u.createdAt)));
    if (idx != null) buckets[idx].count++;
  }

  // Revenue + plan distribution (paying = active stripe sub on a non-free plan).
  let mrrCents = 0;
  let payingCount = 0;
  const planMap = new Map<string, { code: string; name: string; count: number; monthlyCents: number }>();
  for (const s of activeSubs) {
    if (!s.plan) continue;
    const monthly = monthlyEquivalent(s.plan.priceCents, s.plan.interval);
    const entry = planMap.get(s.plan.code) ?? { code: s.plan.code, name: s.plan.name, count: 0, monthlyCents: monthly };
    entry.count++;
    planMap.set(s.plan.code, entry);
    // Only real (stripe) revenue on paid plans counts toward MRR / conversion.
    if (s.billingSource === 'stripe' && s.plan.priceCents > 0) {
      mrrCents += monthly;
      payingCount++;
    }
  }

  // Rep commissions + leaderboard.
  const byRep = new Map<string, number>();
  let commissionsAllTimeCents = 0;
  for (const a of accruals) {
    commissionsAllTimeCents += a.commissionCents;
    byRep.set(a.salesRepId, (byRep.get(a.salesRepId) ?? 0) + a.commissionCents);
  }
  const topRepIds = [...byRep.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
  const repUsers = await db.user.findMany({ where: { id: { in: topRepIds.map(([id]) => id) } }, select: { id: true, email: true } });
  const emailById = new Map(repUsers.map((u) => [u.id, u.email]));
  const top = topRepIds.map(([tenantId, commissionCents]) => ({ tenantId, email: emailById.get(tenantId) ?? null, commissionCents }));

  const pendingPayoutCents = pendingPayouts.reduce((s, p) => s + p.totalCents, 0);

  return {
    users: { total: totalUsers, new7d, new30d },
    signupTrend: buckets,
    revenue: {
      mrrCents,
      arrCents: mrrCents * 12,
      payingCount,
      conversionRate: totalUsers > 0 ? payingCount / totalUsers : 0,
      planDistribution: [...planMap.values()].sort((a, b) => b.count - a.count),
    },
    reps: { active: activeReps, commissionsAllTimeCents, pendingPayoutCents, top },
  };
}
