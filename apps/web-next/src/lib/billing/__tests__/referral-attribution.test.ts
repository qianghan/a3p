/**
 * P0-8: end-to-end attribution verification (mocked DB).
 *
 * Covers the referral chain that the staging checklist in
 * docs/revenue/attribution-audit-2026-10-16.md walks through live:
 *
 *   /register?ref=CODE  →  recordReferralJoin (signup)
 *   → Stripe subscription.active  →  processInviteePaid (paid)
 *   → applyPendingCredits (referrer's Stripe balance)
 *
 * Guards under test: unknown codes, self-referral, duplicate attribution,
 * idempotent paid processing, the 12-month cap, and sales-rep-owned codes
 * (which skip free-month rewards — the rep earns commission via
 * accrueSalesRepCommission on invoice.paid instead).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// --- prisma mocks ----------------------------------------------------------
const codeFindUnique = vi.fn();
const codeFindFirst = vi.fn();
const referralFindUnique = vi.fn();
const referralCreate = vi.fn();
const referralUpdate = vi.fn();
const referralAggregate = vi.fn();
const referralFindMany = vi.fn();
const referralCount = vi.fn();
const subFindUnique = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billReferralCode: {
      findUnique: (...a: unknown[]) => codeFindUnique(...a),
      findFirst: (...a: unknown[]) => codeFindFirst(...a),
    },
    billReferral: {
      findUnique: (...a: unknown[]) => referralFindUnique(...a),
      create: (...a: unknown[]) => referralCreate(...a),
      update: (...a: unknown[]) => referralUpdate(...a),
      aggregate: (...a: unknown[]) => referralAggregate(...a),
      findMany: (...a: unknown[]) => referralFindMany(...a),
      count: (...a: unknown[]) => referralCount(...a),
    },
    billSubscription: { findUnique: (...a: unknown[]) => subFindUnique(...a) },
  },
}));

const createNotification = vi.fn();
// NOTE: mock paths resolve relative to THIS test file (billing/__tests__/),
// so they point at the same modules referrals.ts imports:
//   referrals '../notifications' → lib/notifications  →  '../../notifications'
//   referrals './stripe'          → lib/billing/stripe →  '../stripe'
vi.mock('../../notifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

const createBalanceTransaction = vi.fn();
vi.mock('../stripe', () => ({
  getStripe: () => ({ customers: { createBalanceTransaction: (...a: unknown[]) => createBalanceTransaction(...a) } }),
}));

import { recordReferralJoin, processInviteePaid } from '../referrals';

beforeEach(() => {
  vi.clearAllMocks();
  referralCreate.mockResolvedValue({});
  referralUpdate.mockResolvedValue({});
  createNotification.mockResolvedValue({});
  createBalanceTransaction.mockResolvedValue({});
});

describe('recordReferralJoin (referral link → signup)', () => {
  it('attributes a valid code to the invitee', async () => {
    codeFindUnique.mockResolvedValue({ code: 'AB12-CD34', tenantId: 'referrer1' });
    referralFindUnique.mockResolvedValue(null); // no prior attribution
    const ok = await recordReferralJoin('ab12-cd34', 'invitee1', 'friend@example.com');
    expect(ok).toBe(true);
    expect(referralCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referrerTenantId: 'referrer1',
          inviteeTenantId: 'invitee1',
          status: 'joined',
        }),
      }),
    );
  });

  it('rejects unknown codes', async () => {
    codeFindUnique.mockResolvedValue(null);
    expect(await recordReferralJoin('NOPE-0000', 'invitee1')).toBe(false);
    expect(referralCreate).not.toHaveBeenCalled();
  });

  it('rejects self-referral', async () => {
    codeFindUnique.mockResolvedValue({ code: 'AB12-CD34', tenantId: 'invitee1' });
    expect(await recordReferralJoin('AB12-CD34', 'invitee1')).toBe(false);
    expect(referralCreate).not.toHaveBeenCalled();
  });

  it('rejects duplicate attribution (invitee already attributed)', async () => {
    codeFindUnique.mockResolvedValue({ code: 'AB12-CD34', tenantId: 'referrer1' });
    referralFindUnique.mockResolvedValue({ id: 'existing', inviteeTenantId: 'invitee1' });
    expect(await recordReferralJoin('AB12-CD34', 'invitee1')).toBe(false);
    expect(referralCreate).not.toHaveBeenCalled();
  });
});

describe('processInviteePaid (paid conversion → referrer reward)', () => {
  const joined = {
    id: 'ref1', code: 'AB12-CD34', inviteeTenantId: 'invitee1',
    referrerTenantId: 'referrer1', inviteeEmail: 'friend@example.com',
    status: 'joined', rewardMonths: 0,
  };

  beforeEach(() => {
    // Default: ordinary peer-referral code (not rep-owned).
    codeFindFirst.mockResolvedValue({ code: 'AB12-CD34', tenantId: 'referrer1' });
    // Default: referrer not yet subscribed → credit stays banked.
    subFindUnique.mockResolvedValue(null);
  });

  it('flips joined → paid, assigns 1 reward month, notifies the referrer', async () => {
    referralFindUnique.mockResolvedValue(joined);
    referralAggregate.mockResolvedValue({ _sum: { rewardMonths: 0 } });

    await processInviteePaid('invitee1');

    expect(referralUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ref1' },
        data: expect.objectContaining({ status: 'paid', rewardMonths: 1 }),
      }),
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'referral_thanks' }),
    );
  });

  it('is idempotent: already-paid referrals are not re-processed', async () => {
    referralFindUnique.mockResolvedValue({ ...joined, status: 'paid' });
    await processInviteePaid('invitee1');
    expect(referralUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('respects the 12-month cap: no reward months past the cap', async () => {
    referralFindUnique.mockResolvedValue(joined);
    referralAggregate.mockResolvedValue({ _sum: { rewardMonths: 12 } }); // at cap
    await processInviteePaid('invitee1');
    expect(referralUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paid', rewardMonths: 0 }) }),
    );
  });

  it('sales-rep-owned codes flip to paid WITHOUT free-month rewards', async () => {
    referralFindUnique.mockResolvedValue(joined);
    codeFindFirst.mockResolvedValue({ code: 'AB12-CD34', tenantId: 'rep1', salesRepId: 'rep1' });
    await processInviteePaid('invitee1');
    expect(referralUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paid' }) }),
    );
    // No reward-months path for reps — commission accrues via invoice.paid instead.
    expect(referralAggregate).not.toHaveBeenCalled();
  });

  it('applies banked credits when the referrer subscribes (flush path)', async () => {
    referralFindUnique.mockResolvedValue(joined);
    referralAggregate.mockResolvedValue({ _sum: { rewardMonths: 0 } });
    // Referrer now has a Stripe customer → credit should land on their balance.
    subFindUnique.mockResolvedValue({
      accountId: 'referrer1',
      stripeCustomerId: 'cus_123',
      plan: { priceCents: 1900, currency: 'usd' },
    });
    referralFindMany.mockResolvedValue([{ id: 'ref1' }]);
    referralCount.mockResolvedValue(0);

    await processInviteePaid('invitee1');

    expect(createBalanceTransaction).toHaveBeenCalledWith(
      'cus_123',
      expect.objectContaining({ amount: -1900, currency: 'usd' }),
    );
    expect(referralUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ creditedAt: expect.any(Date) }) }),
    );
  });
});
