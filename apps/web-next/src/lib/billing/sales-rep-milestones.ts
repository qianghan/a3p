import 'server-only';
import { prisma } from '@/lib/db';
import { createNotification } from '@/lib/notifications';

/**
 * Sales-rep milestones — recognition moments computed from existing data
 * (paid referrals, accrued commissions, first payout). Crossing one is
 * recorded once in SalesRepMilestone so we celebrate only the first time; the
 * rep dashboard shows progress toward the next, and the autonomous rep-coach
 * agent (PR-5) reads newly-crossed milestones to trigger a congrats + reward
 * recommendation.
 */

type Metric = 'paidReferrals' | 'commissionsCents' | 'firstPayout';

export interface MilestoneDef {
  key: string;
  label: string;
  metric: Metric;
  threshold: number;
}

export const MILESTONES: MilestoneDef[] = [
  { key: 'first_paid_referral', label: 'First paying referral', metric: 'paidReferrals', threshold: 1 },
  { key: 'referrals_5', label: '5 paying referrals', metric: 'paidReferrals', threshold: 5 },
  { key: 'referrals_10', label: '10 paying referrals', metric: 'paidReferrals', threshold: 10 },
  { key: 'referrals_25', label: '25 paying referrals', metric: 'paidReferrals', threshold: 25 },
  { key: 'commissions_100', label: '$100 in commissions', metric: 'commissionsCents', threshold: 10_000 },
  { key: 'commissions_500', label: '$500 in commissions', metric: 'commissionsCents', threshold: 50_000 },
  { key: 'commissions_1000', label: '$1,000 in commissions', metric: 'commissionsCents', threshold: 100_000 },
  { key: 'first_payout', label: 'First payout received', metric: 'firstPayout', threshold: 1 },
];

export interface RepMetrics {
  paidReferrals: number;
  commissionsCents: number;
  firstPayout: number; // 0 or 1
}

export async function computeRepMetrics(tenantId: string): Promise<RepMetrics> {
  const [paidReferrals, accruals, payoutPaid] = await Promise.all([
    prisma.billReferral.count({ where: { referrerTenantId: tenantId, status: 'paid' } }),
    prisma.salesRepCommissionAccrual.aggregate({ where: { salesRepId: tenantId, reversedAt: null }, _sum: { commissionCents: true } }),
    prisma.salesRepPayout.count({ where: { salesRepId: tenantId, status: 'paid' } }),
  ]);
  return {
    paidReferrals,
    commissionsCents: accruals._sum.commissionCents ?? 0,
    firstPayout: payoutPaid > 0 ? 1 : 0,
  };
}

function metricValue(m: RepMetrics, metric: Metric): number {
  return m[metric];
}

function achievedKeys(m: RepMetrics): string[] {
  return MILESTONES.filter((def) => metricValue(m, def.metric) >= def.threshold).map((d) => d.key);
}

export interface MilestoneProgress {
  metrics: RepMetrics;
  achieved: { key: string; label: string }[];
  /** The next unachieved milestone per metric track, with progress toward it. */
  next: { key: string; label: string; metric: Metric; current: number; threshold: number; pct: number }[];
}

/** Read-only progress snapshot for the rep dashboard. */
export async function computeMilestoneProgress(tenantId: string): Promise<MilestoneProgress> {
  const metrics = await computeRepMetrics(tenantId);
  const achieved = MILESTONES.filter((d) => metricValue(metrics, d.metric) >= d.threshold);
  const next: MilestoneProgress['next'] = [];
  for (const metric of ['paidReferrals', 'commissionsCents'] as Metric[]) {
    const upcoming = MILESTONES.filter((d) => d.metric === metric && metricValue(metrics, metric) < d.threshold)
      .sort((a, b) => a.threshold - b.threshold)[0];
    if (upcoming) {
      const current = metricValue(metrics, metric);
      next.push({ key: upcoming.key, label: upcoming.label, metric, current, threshold: upcoming.threshold, pct: Math.min(100, Math.round((current / upcoming.threshold) * 100)) });
    }
  }
  return {
    metrics,
    achieved: achieved.map((d) => ({ key: d.key, label: d.label })),
    next,
  };
}

function congratsBody(label: string): string {
  return `You just hit a milestone: ${label}. Nice work — keep sharing your link and it compounds. 🎉`;
}

/**
 * Record any newly-crossed milestones and send a one-time congrats. Idempotent
 * (unique [salesRepId, key]); safe to call on every dashboard load or from the
 * coach cron. Returns the milestones newly crossed on this call.
 */
export async function detectAndRecordMilestones(tenantId: string): Promise<{ key: string; label: string }[]> {
  const metrics = await computeRepMetrics(tenantId);
  const achieved = achievedKeys(metrics);
  if (achieved.length === 0) return [];

  const existing = await prisma.salesRepMilestone.findMany({ where: { salesRepId: tenantId }, select: { key: true } });
  const existingSet = new Set(existing.map((e) => e.key));
  const fresh = MILESTONES.filter((d) => achieved.includes(d.key) && !existingSet.has(d.key));
  if (fresh.length === 0) return [];

  const now = new Date();
  await prisma.salesRepMilestone.createMany({
    data: fresh.map((d) => ({ salesRepId: tenantId, key: d.key, achievedAt: now, notifiedAt: now })),
    skipDuplicates: true,
  });

  // Best-effort congrats (recognition only — autonomous per the agreed model).
  for (const d of fresh) {
    createNotification({
      category: 'reward',
      title: `Milestone unlocked: ${d.label} 🎉`,
      body: congratsBody(d.label),
      ctaLabel: 'See your progress',
      ctaUrl: '/sales-rep',
      createdByType: 'system',
      audienceType: 'single',
      audienceFilter: { tenantId },
    }).catch((e) => console.error('[milestones] notify failed:', e));
  }

  return fresh.map((d) => ({ key: d.key, label: d.label }));
}
