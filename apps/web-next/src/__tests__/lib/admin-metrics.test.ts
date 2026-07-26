import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const userCount = vi.fn();
const userFindMany = vi.fn();
const subFindMany = vi.fn();
const repProfileCount = vi.fn();
const accrualFindMany = vi.fn();
const payoutFindMany = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    user: { count: (...a: unknown[]) => userCount(...a), findMany: (...a: unknown[]) => userFindMany(...a) },
    billSubscription: { findMany: (...a: unknown[]) => subFindMany(...a) },
    salesRepProfile: { count: (...a: unknown[]) => repProfileCount(...a) },
    salesRepCommissionAccrual: { findMany: (...a: unknown[]) => accrualFindMany(...a) },
    salesRepPayout: { findMany: (...a: unknown[]) => payoutFindMany(...a) },
  },
}));

import { computePlatformMetrics } from '@/lib/admin-metrics';

beforeEach(() => {
  vi.clearAllMocks();
  // user.count: total, new7d, new30d (call order in Promise.all)
  userCount.mockResolvedValueOnce(100).mockResolvedValueOnce(5).mockResolvedValueOnce(20);
  // user.findMany: first the signup-trend query (select createdAt), then rep emails (where id in)
  userFindMany.mockImplementation((arg: { where?: { id?: unknown } }) => {
    if (arg?.where && 'id' in (arg.where || {})) {
      return Promise.resolve([{ id: 'repA', email: 'a@x.com' }, { id: 'repB', email: 'b@x.com' }]);
    }
    return Promise.resolve([]); // no trend detail needed for these assertions
  });
  subFindMany.mockResolvedValue([
    { billingSource: 'stripe', plan: { code: 'pro', name: 'Pro', priceCents: 1900, interval: 'month' } },
    { billingSource: 'stripe', plan: { code: 'pro', name: 'Pro', priceCents: 1900, interval: 'month' } },
    { billingSource: 'stripe', plan: { code: 'business', name: 'Business', priceCents: 4900, interval: 'month' } },
    { billingSource: 'manual', plan: { code: 'pro', name: 'Pro', priceCents: 1900, interval: 'month' } }, // comped rep — not revenue
    { billingSource: 'stripe', plan: { code: 'free', name: 'Free', priceCents: 0, interval: 'month' } },
    { billingSource: 'stripe', plan: { code: 'free', name: 'Free', priceCents: 0, interval: 'month' } },
    { billingSource: 'stripe', plan: { code: 'free', name: 'Free', priceCents: 0, interval: 'month' } },
  ]);
  repProfileCount.mockResolvedValue(4);
  accrualFindMany.mockResolvedValue([
    { salesRepId: 'repA', commissionCents: 5000 },
    { salesRepId: 'repA', commissionCents: 3000 },
    { salesRepId: 'repB', commissionCents: 2000 },
  ]);
  payoutFindMany.mockResolvedValue([{ totalCents: 6000 }, { totalCents: 4000 }]);
});

describe('computePlatformMetrics', () => {
  it('computes MRR from stripe paid subs only (excludes comped + free)', async () => {
    const m = await computePlatformMetrics(new Date('2026-07-15T00:00:00Z'));
    expect(m.revenue.mrrCents).toBe(1900 + 1900 + 4900); // 8700 — manual pro & free excluded
    expect(m.revenue.arrCents).toBe(8700 * 12);
    expect(m.revenue.payingCount).toBe(3);
    expect(m.revenue.conversionRate).toBeCloseTo(3 / 100);
  });

  it('counts plan distribution across all active subs (incl. comped)', async () => {
    const m = await computePlatformMetrics(new Date('2026-07-15T00:00:00Z'));
    const pro = m.revenue.planDistribution.find((p) => p.code === 'pro');
    const free = m.revenue.planDistribution.find((p) => p.code === 'free');
    expect(pro?.count).toBe(3); // 2 stripe + 1 manual
    expect(free?.count).toBe(3);
  });

  it('normalizes annual plans to a monthly MRR figure', async () => {
    subFindMany.mockResolvedValueOnce([
      { billingSource: 'stripe', plan: { code: 'pro_annual', name: 'Pro (annual)', priceCents: 22800, interval: 'year' } },
    ]);
    const m = await computePlatformMetrics(new Date('2026-07-15T00:00:00Z'));
    expect(m.revenue.mrrCents).toBe(Math.round(22800 / 12)); // 1900
  });

  it('ranks top reps by non-reversed commissions and sums all-time', async () => {
    const m = await computePlatformMetrics(new Date('2026-07-15T00:00:00Z'));
    expect(m.reps.commissionsAllTimeCents).toBe(10000);
    expect(m.reps.top[0]).toMatchObject({ tenantId: 'repA', email: 'a@x.com', commissionCents: 8000 });
    expect(m.reps.top[1]).toMatchObject({ tenantId: 'repB', commissionCents: 2000 });
    expect(m.reps.pendingPayoutCents).toBe(10000);
    expect(m.reps.active).toBe(4);
  });

  it('builds 6 monthly signup buckets', async () => {
    const m = await computePlatformMetrics(new Date('2026-07-15T00:00:00Z'));
    expect(m.signupTrend).toHaveLength(6);
    expect(m.signupTrend[5].month).toBe('2026-07');
    expect(m.signupTrend[0].month).toBe('2026-02');
  });
});
