import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const profileFindUnique = vi.fn();
const profileFindUniqueOrThrow = vi.fn();
const profileUpdate = vi.fn();
const payoutFindUniqueOrThrow = vi.fn();
const payoutUpdate = vi.fn();
const accountsRetrieve = vi.fn();
const transfersCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    salesRepProfile: {
      findUnique: (...a: unknown[]) => profileFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => profileFindUniqueOrThrow(...a),
      update: (...a: unknown[]) => profileUpdate(...a),
    },
    salesRepPayout: {
      findUniqueOrThrow: (...a: unknown[]) => payoutFindUniqueOrThrow(...a),
      update: (...a: unknown[]) => payoutUpdate(...a),
    },
  },
}));

vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    accounts: { retrieve: (...a: unknown[]) => accountsRetrieve(...a) },
    transfers: { create: (...a: unknown[]) => transfersCreate(...a) },
  }),
}));

import { refreshConnectStatus, payRepViaStripeTransfer, StripePayoutError } from '../sales-rep-connect';

beforeEach(() => {
  profileFindUnique.mockReset();
  profileFindUniqueOrThrow.mockReset();
  profileUpdate.mockReset();
  payoutFindUniqueOrThrow.mockReset();
  payoutUpdate.mockReset();
  accountsRetrieve.mockReset();
  transfersCreate.mockReset();
});

describe('refreshConnectStatus', () => {
  it('no-ops when the rep has no Connect account yet', async () => {
    profileFindUnique.mockResolvedValue({ stripeConnectAccountId: null });
    await refreshConnectStatus('rep-1');
    expect(accountsRetrieve).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it('writes the account status booleans from Stripe', async () => {
    profileFindUnique.mockResolvedValue({ stripeConnectAccountId: 'acct_123' });
    accountsRetrieve.mockResolvedValue({
      charges_enabled: false,
      payouts_enabled: true,
      details_submitted: true,
    });

    await refreshConnectStatus('rep-1');

    expect(accountsRetrieve).toHaveBeenCalledWith('acct_123');
    expect(profileUpdate).toHaveBeenCalledWith({
      where: { tenantId: 'rep-1' },
      data: expect.objectContaining({
        stripeConnectChargesEnabled: false,
        stripeConnectPayoutsEnabled: true,
        stripeConnectDetailsSubmitted: true,
      }),
    });
  });
});

describe('payRepViaStripeTransfer', () => {
  const payout = { id: 'payout-1', salesRepId: 'rep-1', status: 'submitted', totalCents: 5000, invoiceNumber: 'COMM-2026-0001' };

  it('refuses to pay a rep who has not started Connect onboarding', async () => {
    payoutFindUniqueOrThrow.mockResolvedValue(payout);
    profileFindUniqueOrThrow.mockResolvedValue({ tenantId: 'rep-1', stripeConnectAccountId: null, stripeConnectPayoutsEnabled: false });

    await expect(payRepViaStripeTransfer('payout-1', 'admin-1')).rejects.toThrow(StripePayoutError);
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it('refuses to pay a rep who has not finished verification', async () => {
    payoutFindUniqueOrThrow.mockResolvedValue(payout);
    profileFindUniqueOrThrow.mockResolvedValue({ tenantId: 'rep-1', stripeConnectAccountId: 'acct_123', stripeConnectPayoutsEnabled: false });

    await expect(payRepViaStripeTransfer('payout-1', 'admin-1')).rejects.toThrow(StripePayoutError);
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it('refuses to re-pay an already-paid payout', async () => {
    payoutFindUniqueOrThrow.mockResolvedValue({ ...payout, status: 'paid' });
    await expect(payRepViaStripeTransfer('payout-1', 'admin-1')).rejects.toThrow(StripePayoutError);
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it('transfers the exact payout amount and records the transfer id when the rep is ready', async () => {
    payoutFindUniqueOrThrow.mockResolvedValue(payout);
    profileFindUniqueOrThrow.mockResolvedValue({ tenantId: 'rep-1', stripeConnectAccountId: 'acct_123', stripeConnectPayoutsEnabled: true });
    transfersCreate.mockResolvedValue({ id: 'tr_abc123' });

    await payRepViaStripeTransfer('payout-1', 'admin-1');

    expect(transfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'usd', amount: 5000, destination: 'acct_123' }),
    );
    expect(payoutUpdate).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: expect.objectContaining({
        status: 'paid',
        paidBy: 'admin-1',
        payoutMethod: 'stripe',
        stripeTransferId: 'tr_abc123',
      }),
    });
  });

  it('translates a balance_insufficient Stripe error into a friendly message', async () => {
    payoutFindUniqueOrThrow.mockResolvedValue(payout);
    profileFindUniqueOrThrow.mockResolvedValue({ tenantId: 'rep-1', stripeConnectAccountId: 'acct_123', stripeConnectPayoutsEnabled: true });
    transfersCreate.mockRejectedValue({ code: 'balance_insufficient' });

    await expect(payRepViaStripeTransfer('payout-1', 'admin-1')).rejects.toThrow(/balance is insufficient/i);
    expect(payoutUpdate).not.toHaveBeenCalled();
  });
});
