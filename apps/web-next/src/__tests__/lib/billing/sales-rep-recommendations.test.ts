import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const recFindUnique = vi.fn();
const recUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: { salesRepRecommendation: { findUnique: (...a: unknown[]) => recFindUnique(...a), update: (...a: unknown[]) => recUpdate(...a) } },
}));
const updateRepCommission = vi.fn();
vi.mock('@/lib/billing/sales-rep-admin', () => ({ updateRepCommission: (...a: unknown[]) => updateRepCommission(...a) }));
const createNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

import { decideRecommendation, RecommendationError } from '@/lib/billing/sales-rep-recommendations';

beforeEach(() => {
  vi.clearAllMocks();
  recUpdate.mockResolvedValue({});
  updateRepCommission.mockResolvedValue({});
  createNotification.mockResolvedValue({});
});

describe('decideRecommendation', () => {
  it('approving a commission_raise applies it via updateRepCommission and notifies the rep', async () => {
    recFindUnique.mockResolvedValue({ id: 'r1', salesRepId: 't1', type: 'commission_raise', status: 'pending', payload: { fromBps: 2000, toBps: 2250 } });
    const res = await decideRecommendation('r1', 'admin1', 'approve');
    expect(updateRepCommission).toHaveBeenCalledWith('t1', { commissionBps: 2250 });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ audienceFilter: { tenantId: 't1' } }));
    expect(recUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'approved', decidedBy: 'admin1' }) }));
    expect(res.applied).toBe(true);
  });

  it('approving a reward notifies the rep but does not change commission', async () => {
    recFindUnique.mockResolvedValue({ id: 'r2', salesRepId: 't1', type: 'reward', status: 'pending', payload: { kind: 'bonus' } });
    const res = await decideRecommendation('r2', 'admin1', 'approve');
    expect(updateRepCommission).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
    expect(res.applied).toBe(true);
  });

  it('dismissing applies nothing and closes it', async () => {
    recFindUnique.mockResolvedValue({ id: 'r3', salesRepId: 't1', type: 'commission_raise', status: 'pending', payload: { toBps: 2250 } });
    const res = await decideRecommendation('r3', 'admin1', 'dismiss');
    expect(updateRepCommission).not.toHaveBeenCalled();
    expect(recUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'dismissed' }) }));
    expect(res.applied).toBe(false);
  });

  it('rejects an unknown or already-decided recommendation', async () => {
    recFindUnique.mockResolvedValue(null);
    await expect(decideRecommendation('x', 'admin1', 'approve')).rejects.toThrow(RecommendationError);
    recFindUnique.mockResolvedValue({ id: 'r4', salesRepId: 't1', type: 'reward', status: 'approved', payload: {} });
    await expect(decideRecommendation('r4', 'admin1', 'approve')).rejects.toThrow(/already/);
  });

  it('rejects a commission_raise with an invalid toBps', async () => {
    recFindUnique.mockResolvedValue({ id: 'r5', salesRepId: 't1', type: 'commission_raise', status: 'pending', payload: { toBps: 99999 } });
    await expect(decideRecommendation('r5', 'admin1', 'approve')).rejects.toThrow(RecommendationError);
    expect(updateRepCommission).not.toHaveBeenCalled();
  });
});
