import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('server-only', () => ({}));

const referralFindUnique = vi.fn();
const codeFindFirst = vi.fn();
const profileFindUnique = vi.fn();
const accrualCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billReferral: { findUnique: (...a: unknown[]) => referralFindUnique(...a) },
    billReferralCode: { findFirst: (...a: unknown[]) => codeFindFirst(...a) },
    salesRepProfile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    salesRepCommissionAccrual: { create: (...a: unknown[]) => accrualCreate(...a) },
  },
}));

import { accrueSalesRepCommission } from '@/lib/billing/sales-rep';

function invoice(amountPaid: number): Stripe.Invoice {
  return { amount_paid: amountPaid, period_start: 1_700_000_000, period_end: 1_702_600_000 } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  accrualCreate.mockResolvedValue({});
  // Default happy path: referred via a rep's code, active rep at 20%.
  referralFindUnique.mockResolvedValue({ id: 'ref1', code: 'AB12-CD34', inviteeTenantId: 'invitee1' });
  codeFindFirst.mockResolvedValue({ code: 'AB12-CD34', salesRepId: 'rep1' });
  profileFindUnique.mockResolvedValue({ tenantId: 'rep1', status: 'active', commissionBps: 2000 });
});

describe('accrueSalesRepCommission', () => {
  it('accrues commission = revenue × bps/10000 and locks the rate used', async () => {
    await accrueSalesRepCommission('invitee1', invoice(19_00), 'evt_1');
    expect(accrualCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        salesRepId: 'rep1',
        inviteeTenantId: 'invitee1',
        stripeEventId: 'evt_1',
        revenueCents: 1900,
        commissionBpsUsed: 2000,
        commissionCents: 380, // 1900 * 20%
      }),
    }));
  });

  it('rounds commission correctly on odd amounts', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 'rep1', status: 'active', commissionBps: 1500 });
    await accrueSalesRepCommission('invitee1', invoice(4999), 'evt_2'); // 4999 * 15% = 749.85 → 750
    expect(accrualCreate.mock.calls[0][0].data.commissionCents).toBe(750);
  });

  it('no-ops when the payer was not referred at all', async () => {
    referralFindUnique.mockResolvedValue(null);
    await accrueSalesRepCommission('invitee1', invoice(1900), 'evt_3');
    expect(accrualCreate).not.toHaveBeenCalled();
  });

  it('no-ops for an ordinary peer referral (code has no salesRepId)', async () => {
    codeFindFirst.mockResolvedValue({ code: 'AB12-CD34', salesRepId: null });
    await accrueSalesRepCommission('invitee1', invoice(1900), 'evt_4');
    expect(accrualCreate).not.toHaveBeenCalled();
  });

  it('no-ops when the rep is removed/suspended', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 'rep1', status: 'removed', commissionBps: 2000 });
    await accrueSalesRepCommission('invitee1', invoice(1900), 'evt_5');
    expect(accrualCreate).not.toHaveBeenCalled();
  });

  it('no-ops on a $0 invoice (e.g. fully credit-covered)', async () => {
    await accrueSalesRepCommission('invitee1', invoice(0), 'evt_6');
    expect(accrualCreate).not.toHaveBeenCalled();
  });

  it('is idempotent on a webhook retry (P2002 duplicate swallowed)', async () => {
    const dup = Object.assign(new Error('unique'), { code: 'P2002' });
    accrualCreate.mockRejectedValueOnce(dup);
    await expect(accrueSalesRepCommission('invitee1', invoice(1900), 'evt_7')).resolves.toBeUndefined();
  });

  it('rethrows a non-duplicate DB error', async () => {
    accrualCreate.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P1001' }));
    await expect(accrueSalesRepCommission('invitee1', invoice(1900), 'evt_8')).rejects.toThrow('db down');
  });
});
