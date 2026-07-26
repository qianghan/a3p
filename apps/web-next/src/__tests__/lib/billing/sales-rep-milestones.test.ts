import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const referralCount = vi.fn();
const accrualAggregate = vi.fn();
const payoutCount = vi.fn();
const milestoneFindMany = vi.fn();
const milestoneCreateMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    billReferral: { count: (...a: unknown[]) => referralCount(...a) },
    salesRepCommissionAccrual: { aggregate: (...a: unknown[]) => accrualAggregate(...a) },
    salesRepPayout: { count: (...a: unknown[]) => payoutCount(...a) },
    salesRepMilestone: { findMany: (...a: unknown[]) => milestoneFindMany(...a), createMany: (...a: unknown[]) => milestoneCreateMany(...a) },
  },
}));
const createNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

import { computeMilestoneProgress, detectAndRecordMilestones } from '@/lib/billing/sales-rep-milestones';

function setMetrics(paidReferrals: number, commissionsCents: number, paidPayouts: number) {
  referralCount.mockResolvedValue(paidReferrals);
  accrualAggregate.mockResolvedValue({ _sum: { commissionCents: commissionsCents } });
  payoutCount.mockResolvedValue(paidPayouts);
}

beforeEach(() => {
  vi.clearAllMocks();
  createNotification.mockResolvedValue({});
  milestoneCreateMany.mockResolvedValue({ count: 0 });
});

describe('computeMilestoneProgress', () => {
  it('marks crossed milestones achieved and reports next per track with progress', async () => {
    setMetrics(6, 12_000, 0); // 6 paid referrals, $120 commissions, no payout
    const p = await computeMilestoneProgress('t1');
    const achievedKeys = p.achieved.map((a) => a.key);
    expect(achievedKeys).toEqual(expect.arrayContaining(['first_paid_referral', 'referrals_5', 'commissions_100']));
    expect(achievedKeys).not.toContain('referrals_10');
    const nextRef = p.next.find((n) => n.metric === 'paidReferrals');
    const nextComm = p.next.find((n) => n.metric === 'commissionsCents');
    expect(nextRef).toMatchObject({ key: 'referrals_10', current: 6, threshold: 10, pct: 60 });
    expect(nextComm).toMatchObject({ key: 'commissions_500', current: 12_000, threshold: 50_000, pct: 24 });
  });
});

describe('detectAndRecordMilestones', () => {
  it('records only newly-crossed milestones and congratulates once each', async () => {
    setMetrics(5, 10_000, 0); // achieves first_paid_referral, referrals_5, commissions_100
    milestoneFindMany.mockResolvedValue([{ key: 'first_paid_referral' }]); // already had the first

    const fresh = await detectAndRecordMilestones('t1');

    expect(fresh.map((f) => f.key).sort()).toEqual(['commissions_100', 'referrals_5']);
    const created = milestoneCreateMany.mock.calls[0][0].data.map((d: { key: string }) => d.key).sort();
    expect(created).toEqual(['commissions_100', 'referrals_5']);
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ category: 'reward', audienceType: 'single', audienceFilter: { tenantId: 't1' } }));
  });

  it('is idempotent — no new records or notifications when nothing crossed', async () => {
    setMetrics(5, 10_000, 0);
    milestoneFindMany.mockResolvedValue([{ key: 'first_paid_referral' }, { key: 'referrals_5' }, { key: 'commissions_100' }]);
    const fresh = await detectAndRecordMilestones('t1');
    expect(fresh).toEqual([]);
    expect(milestoneCreateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('returns nothing when no milestone is achieved yet', async () => {
    setMetrics(0, 0, 0);
    const fresh = await detectAndRecordMilestones('t1');
    expect(fresh).toEqual([]);
    expect(milestoneFindMany).not.toHaveBeenCalled();
  });
});
