import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const appFindUnique = vi.fn();
const appFindMany = vi.fn();
const appUpdate = vi.fn();
const contractFindUnique = vi.fn();
const contractFindMany = vi.fn();
const userFindUnique = vi.fn();
const userFindMany = vi.fn();
const roleFindUnique = vi.fn();
const subFindUnique = vi.fn();
const userRoleUpsert = vi.fn();
const profileUpsert = vi.fn();
const refCodeUpdate = vi.fn();

const tx = {
  userRole: { upsert: (...a: unknown[]) => userRoleUpsert(...a) },
  salesRepProfile: { upsert: (...a: unknown[]) => profileUpsert(...a) },
  salesRepApplication: { update: (...a: unknown[]) => appUpdate(...a) },
};

vi.mock('@/lib/db', () => ({
  prisma: {
    salesRepApplication: {
      findUnique: (...a: unknown[]) => appFindUnique(...a),
      findMany: (...a: unknown[]) => appFindMany(...a),
      update: (...a: unknown[]) => appUpdate(...a),
    },
    salesRepContract: {
      findUnique: (...a: unknown[]) => contractFindUnique(...a),
      findMany: (...a: unknown[]) => contractFindMany(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a), findMany: (...a: unknown[]) => userFindMany(...a) },
    role: { findUnique: (...a: unknown[]) => roleFindUnique(...a) },
    billSubscription: { findUnique: (...a: unknown[]) => subFindUnique(...a) },
    billReferralCode: { update: (...a: unknown[]) => refCodeUpdate(...a) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));
const invalidateAccount = vi.fn();
vi.mock('@naap/billing', () => ({ invalidateAccount: (...a: unknown[]) => invalidateAccount(...a) }));
const getOrCreateReferralCode = vi.fn();
vi.mock('@/lib/billing/referrals', () => ({ getOrCreateReferralCode: (...a: unknown[]) => getOrCreateReferralCode(...a) }));
const createNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

import {
  approveApplication,
  rejectApplication,
  requestMoreInfo,
  listApplicationsForReview,
  ApplicationReviewError,
} from '@/lib/billing/sales-rep-application-review';

beforeEach(() => {
  vi.clearAllMocks();
  roleFindUnique.mockResolvedValue({ id: 'role_rep' });
  getOrCreateReferralCode.mockResolvedValue('AB12-CD34');
  createNotification.mockResolvedValue({});
  refCodeUpdate.mockResolvedValue({});
  appUpdate.mockResolvedValue({});
  userRoleUpsert.mockResolvedValue({});
  profileUpsert.mockResolvedValue({});
});

const SUBMITTED = { id: 'app1', tenantId: 't1', status: 'submitted' };

describe('approveApplication', () => {
  it('provisions the rep: role + profile + referral code, keeps their paid plan, and notifies', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    contractFindUnique.mockResolvedValue({ commissionBpsAtSigning: 2000 });
    subFindUnique.mockResolvedValue({ billingSource: 'stripe' }); // applicant pays their own plan

    const res = await approveApplication('app1', 'admin1');

    expect(res).toMatchObject({ tenantId: 't1', commissionBps: 2000, referralCode: 'AB12-CD34' });
    // role granted
    expect(userRoleUpsert).toHaveBeenCalled();
    // profile created with the SIGNED rate and the applicant's own billing source (NOT comped 'manual')
    const profileArg = profileUpsert.mock.calls[0][0];
    expect(profileArg.create).toMatchObject({ tenantId: 't1', commissionBps: 2000, billingSource: 'stripe' });
    // status flipped to approved
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'approved', reviewDecision: 'approve', reviewedBy: 'admin1' }) }));
    // referral code linked to the rep
    expect(refCodeUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'AB12-CD34' }, data: { salesRepId: 't1' } }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ audienceType: 'single', audienceFilter: { tenantId: 't1' } }));
    // never comped a plan (no BillSubscription upsert in the tx mock surface)
  });

  it('honors an admin override rate over the signed rate', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    contractFindUnique.mockResolvedValue({ commissionBpsAtSigning: 2000 });
    subFindUnique.mockResolvedValue({ billingSource: 'stripe' });
    await approveApplication('app1', 'admin1', { commissionBps: 2500 });
    expect(profileUpsert.mock.calls[0][0].create.commissionBps).toBe(2500);
  });

  it('refuses to approve an application that is not in a reviewable state', async () => {
    appFindUnique.mockResolvedValue({ id: 'app1', tenantId: 't1', status: 'approved' });
    await expect(approveApplication('app1', 'admin1')).rejects.toThrow(ApplicationReviewError);
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid commission override', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    contractFindUnique.mockResolvedValue({ commissionBpsAtSigning: 2000 });
    await expect(approveApplication('app1', 'admin1', { commissionBps: 20000 })).rejects.toThrow(/1.*10000|10000/);
  });
});

describe('rejectApplication', () => {
  it('sets rejected with the reason and notifies', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    await rejectApplication('app1', 'admin1', 'Not enough audience fit');
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'rejected', reviewNotes: 'Not enough audience fit' }) }));
    expect(createNotification).toHaveBeenCalled();
  });
  it('requires a reason', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    await expect(rejectApplication('app1', 'admin1', '   ')).rejects.toThrow(ApplicationReviewError);
  });
});

describe('requestMoreInfo', () => {
  it('sets more_info_requested with the message and notifies', async () => {
    appFindUnique.mockResolvedValue(SUBMITTED);
    await requestMoreInfo('app1', 'admin1', 'Tell us about your audience');
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'more_info_requested', moreInfoMessage: 'Tell us about your audience' }) }));
    expect(createNotification).toHaveBeenCalled();
  });
});

describe('listApplicationsForReview', () => {
  it('joins user + signed commission and maps to list items', async () => {
    appFindMany.mockResolvedValue([
      { id: 'app1', tenantId: 't1', status: 'submitted', jurisdiction: 'us', eligibilityPlanCode: 'pro', annualFeeCentsPaid: 22800, submittedAt: new Date('2026-07-01'), createdAt: new Date('2026-07-01'), aiRiskLevel: null, aiRecommendation: null },
    ]);
    userFindMany.mockResolvedValue([{ id: 't1', email: 'rep@x.com', displayName: 'Rep One' }]);
    contractFindMany.mockResolvedValue([{ applicationId: 'app1', commissionBpsAtSigning: 2000 }]);
    const list = await listApplicationsForReview();
    expect(list[0]).toMatchObject({ id: 'app1', user: { email: 'rep@x.com' }, signedCommissionBps: 2000 });
  });
});
