import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const billSubscriptionFindUnique = vi.fn();
const billSubscriptionFindUniqueOrThrow = vi.fn();
const salesRepApplicationFindFirst = vi.fn();
const salesRepApplicationFindUnique = vi.fn();
const salesRepApplicationCreate = vi.fn();
const salesRepApplicationUpdate = vi.fn();
const abTenantConfigFindUnique = vi.fn();
const salesRepProfileFindUnique = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: {
      findUnique: (...a: unknown[]) => billSubscriptionFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => billSubscriptionFindUniqueOrThrow(...a),
    },
    salesRepApplication: {
      findFirst: (...a: unknown[]) => salesRepApplicationFindFirst(...a),
      findUnique: (...a: unknown[]) => salesRepApplicationFindUnique(...a),
      create: (...a: unknown[]) => salesRepApplicationCreate(...a),
      update: (...a: unknown[]) => salesRepApplicationUpdate(...a),
    },
    abTenantConfig: {
      findUnique: (...a: unknown[]) => abTenantConfigFindUnique(...a),
    },
    salesRepProfile: {
      findUnique: (...a: unknown[]) => salesRepProfileFindUnique(...a),
    },
  },
}));

import {
  checkPartnerEligibility,
  startOrResumeApplication,
  saveApplicationDraft,
} from '../sales-rep-application';

beforeEach(() => {
  billSubscriptionFindUnique.mockReset();
  billSubscriptionFindUniqueOrThrow.mockReset();
  salesRepApplicationFindFirst.mockReset();
  salesRepApplicationFindUnique.mockReset();
  salesRepApplicationCreate.mockReset();
  salesRepApplicationUpdate.mockReset();
  abTenantConfigFindUnique.mockReset();
  salesRepProfileFindUnique.mockReset();
  salesRepProfileFindUnique.mockResolvedValue(null); // default: not already a rep by any path
});

const paidAnnualSub = {
  status: 'active',
  billingSource: 'stripe',
  plan: { code: 'pro', interval: 'year', priceCents: 30000 },
};

describe('checkPartnerEligibility', () => {
  it('is ineligible with no subscription at all', async () => {
    billSubscriptionFindUnique.mockResolvedValue(null);
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(false);
  });

  it('is ineligible on the free plan', async () => {
    billSubscriptionFindUnique.mockResolvedValue({ ...paidAnnualSub, plan: { ...paidAnnualSub.plan, code: 'free' } });
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/paid plan/i);
  });

  it('is ineligible on monthly billing even on a paid plan', async () => {
    billSubscriptionFindUnique.mockResolvedValue({ ...paidAnnualSub, plan: { ...paidAnnualSub.plan, interval: 'month' } });
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/annual/i);
  });

  it('is ineligible on a comped (manual) subscription even if annual and paid-tier', async () => {
    billSubscriptionFindUnique.mockResolvedValue({ ...paidAnnualSub, billingSource: 'manual' });
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/comped/i);
  });

  it('is eligible on an active, paid, annual, non-free subscription', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(true);
  });

  it('is ineligible for a tenant already an active rep via the admin-direct-invite path (no SalesRepApplication row exists for them)', async () => {
    salesRepProfileFindUnique.mockResolvedValue({ tenantId: 't1', status: 'active' });
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/already an active partner/i);
    // Should short-circuit before even checking the subscription.
    expect(billSubscriptionFindUnique).not.toHaveBeenCalled();
  });

  it('is still eligible for a rep whose profile exists but is removed/suspended, not active', async () => {
    salesRepProfileFindUnique.mockResolvedValue({ tenantId: 't1', status: 'removed' });
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    const r = await checkPartnerEligibility('t1');
    expect(r.eligible).toBe(true);
  });
});

describe('startOrResumeApplication', () => {
  it('throws with the eligibility reason when ineligible', async () => {
    billSubscriptionFindUnique.mockResolvedValue(null);
    await expect(startOrResumeApplication('t1')).rejects.toThrow('active subscription');
  });

  it('resumes an existing draft instead of creating a new one', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    const draft = { id: 'app1', tenantId: 't1', status: 'draft' };
    salesRepApplicationFindFirst.mockResolvedValue(draft);

    const result = await startOrResumeApplication('t1');
    expect(result).toBe(draft);
    expect(salesRepApplicationCreate).not.toHaveBeenCalled();
  });

  it('refuses a second application while one is under review', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    salesRepApplicationFindFirst.mockResolvedValue({ id: 'app1', status: 'under_review' });
    await expect(startOrResumeApplication('t1')).rejects.toThrow('already have an application');
  });

  it('refuses a new application for an already-approved tenant', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    salesRepApplicationFindFirst.mockResolvedValue({ id: 'app1', status: 'approved' });
    await expect(startOrResumeApplication('t1')).rejects.toThrow('already an approved partner');
  });

  it('enforces the 90-day reapplication cooldown after a rejection', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    const reviewedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    salesRepApplicationFindFirst.mockResolvedValue({ id: 'app1', status: 'rejected', reviewedAt });
    await expect(startOrResumeApplication('t1')).rejects.toThrow('reapply after');
  });

  it('allows a new application once the 90-day cooldown has elapsed', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    billSubscriptionFindUniqueOrThrow.mockResolvedValue(paidAnnualSub);
    const reviewedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
    salesRepApplicationFindFirst.mockResolvedValue({ id: 'app1', status: 'rejected', reviewedAt });
    abTenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    salesRepApplicationCreate.mockResolvedValue({ id: 'app2', status: 'draft' });

    const result = await startOrResumeApplication('t1');
    expect(salesRepApplicationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jurisdiction: 'ca', status: 'draft' }) }),
    );
    expect(result).toEqual({ id: 'app2', status: 'draft' });
  });

  it('creates a fresh draft with a correct eligibility snapshot when there is no prior application', async () => {
    billSubscriptionFindUnique.mockResolvedValue(paidAnnualSub);
    billSubscriptionFindUniqueOrThrow.mockResolvedValue(paidAnnualSub);
    salesRepApplicationFindFirst.mockResolvedValue(null);
    abTenantConfigFindUnique.mockResolvedValue(null);
    salesRepApplicationCreate.mockResolvedValue({ id: 'app1', status: 'draft' });

    await startOrResumeApplication('t1');
    expect(salesRepApplicationCreate).toHaveBeenCalledWith({
      data: {
        tenantId: 't1',
        status: 'draft',
        jurisdiction: 'us', // falls back to 'us' when no tenant config exists
        answers: {},
        eligibilityPlanCode: 'pro',
        eligibilityInterval: 'year',
        annualFeeCentsPaid: 30000,
      },
    });
  });
});

describe('saveApplicationDraft', () => {
  it('refuses to update another tenant\'s application', async () => {
    salesRepApplicationFindUnique.mockResolvedValue({ id: 'app1', tenantId: 'other-tenant', status: 'draft' });
    await expect(saveApplicationDraft('t1', 'app1', { jurisdiction: 'uk' })).rejects.toThrow('not found');
  });

  it('refuses to update an application that is no longer a draft', async () => {
    salesRepApplicationFindUnique.mockResolvedValue({ id: 'app1', tenantId: 't1', status: 'submitted' });
    await expect(saveApplicationDraft('t1', 'app1', { jurisdiction: 'uk' })).rejects.toThrow('already been submitted');
  });

  it('merges new answers into existing answers rather than replacing them', async () => {
    salesRepApplicationFindUnique.mockResolvedValue({
      id: 'app1', tenantId: 't1', status: 'draft', answers: { motivation: 'friends' },
    });
    salesRepApplicationUpdate.mockResolvedValue({});

    await saveApplicationDraft('t1', 'app1', { answers: { channel: 'linkedin' } });
    expect(salesRepApplicationUpdate).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { answers: { motivation: 'friends', channel: 'linkedin' } },
    });
  });
});
