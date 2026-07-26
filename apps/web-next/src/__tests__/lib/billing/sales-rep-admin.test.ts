import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const profileFindUnique = vi.fn();
const profileUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: { salesRepProfile: { findUnique: (...a: unknown[]) => profileFindUnique(...a), update: (...a: unknown[]) => profileUpdate(...a) } },
}));
const invalidateAccount = vi.fn();
vi.mock('@naap/billing', () => ({ invalidateAccount: (...a: unknown[]) => invalidateAccount(...a) }));

import { updateRepCommission, RepAdminError } from '@/lib/billing/sales-rep-admin';

beforeEach(() => {
  vi.clearAllMocks();
  profileFindUnique.mockResolvedValue({ tenantId: 't1', status: 'active', commissionBps: 2000, payoutFrequency: 'quarterly' });
  profileUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ tenantId: 't1', commissionBps: data.commissionBps ?? 2000, payoutFrequency: data.payoutFrequency ?? 'quarterly' }));
});

describe('updateRepCommission', () => {
  it('updates only commission + frequency (never the plan) and invalidates cache', async () => {
    const res = await updateRepCommission('t1', { commissionBps: 2500, payoutFrequency: 'monthly' });
    expect(profileUpdate).toHaveBeenCalledWith({ where: { tenantId: 't1' }, data: { commissionBps: 2500, payoutFrequency: 'monthly' } });
    expect(res).toMatchObject({ commissionBps: 2500, payoutFrequency: 'monthly' });
    expect(invalidateAccount).toHaveBeenCalledWith('t1');
  });

  it('allows a partial update (rate only)', async () => {
    await updateRepCommission('t1', { commissionBps: 1500 });
    expect(profileUpdate).toHaveBeenCalledWith({ where: { tenantId: 't1' }, data: { commissionBps: 1500 } });
  });

  it('rejects a non-rep', async () => {
    profileFindUnique.mockResolvedValue(null);
    await expect(updateRepCommission('t1', { commissionBps: 2000 })).rejects.toThrow(RepAdminError);
  });

  it('rejects a removed/suspended rep', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 't1', status: 'removed' });
    await expect(updateRepCommission('t1', { commissionBps: 2000 })).rejects.toThrow(/removed/);
  });

  it('rejects an out-of-range rate and an invalid frequency', async () => {
    await expect(updateRepCommission('t1', { commissionBps: 0 })).rejects.toThrow(RepAdminError);
    await expect(updateRepCommission('t1', { commissionBps: 20000 })).rejects.toThrow(RepAdminError);
    await expect(updateRepCommission('t1', { payoutFrequency: 'weekly' })).rejects.toThrow(RepAdminError);
  });

  it('rejects an empty update', async () => {
    await expect(updateRepCommission('t1', {})).rejects.toThrow(/Nothing to update/);
  });
});
