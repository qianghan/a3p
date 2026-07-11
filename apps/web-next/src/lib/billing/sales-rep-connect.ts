import 'server-only';
import { prisma } from '@naap/database';
import { getStripe } from './stripe';
import { requireActiveSalesRep } from './sales-rep';

/**
 * Stripe Connect Express integration for sales rep payouts — replaces the
 * old plain-text bank-details field. A rep completes Stripe's own hosted
 * onboarding (real bank details + identity verification), and admin pays
 * them with a real stripe.transfers.create() call (see payRepViaStripeTransfer),
 * which Stripe then deposits to the rep's actual bank account.
 *
 * Uses the "separate charges and transfers" model, not destination charges —
 * commission was already collected as general platform revenue, not tied to
 * one original charge.
 */

const JURISDICTION_TO_COUNTRY: Record<string, string> = {
  us: 'US',
  ca: 'CA',
  uk: 'GB',
  au: 'AU',
};

async function countryForRep(tenantId: string): Promise<string> {
  const config = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  return JURISDICTION_TO_COUNTRY[config?.jurisdiction ?? 'us'] ?? 'US';
}

/** Idempotent — returns the existing Connect account id if one is already on file. */
export async function getOrCreateConnectAccount(tenantId: string): Promise<string> {
  const profile = await prisma.salesRepProfile.findUniqueOrThrow({ where: { tenantId } });
  if (profile.stripeConnectAccountId) return profile.stripeConnectAccountId;

  const user = await prisma.user.findUnique({ where: { id: tenantId }, select: { email: true } });
  const country = await countryForRep(tenantId);

  const account = await getStripe().accounts.create({
    type: 'express',
    country,
    email: user?.email ?? undefined,
    // Stripe rejects requesting `transfers` alone for several countries
    // (confirmed live in test mode: "cannot request the transfers
    // capability without the card_payments capability for accounts in
    // US") — card_payments goes unused (we never charge these accounts),
    // but Express bundles the two for verification purposes.
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    business_type: 'individual',
    metadata: { tenantId, purpose: 'sales_rep_commission_payout' },
  });

  await prisma.salesRepProfile.update({
    where: { tenantId },
    data: { stripeConnectAccountId: account.id },
  });

  return account.id;
}

/** Returns a Stripe-hosted onboarding link (new account, or resuming an incomplete one). */
export async function createOnboardingLink(tenantId: string, returnUrl: string, refreshUrl: string): Promise<string> {
  await requireActiveSalesRep(tenantId);
  const accountId = await getOrCreateConnectAccount(tenantId);

  const link = await getStripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });

  return link.url;
}

/**
 * Pulls the latest Account status from Stripe and persists it. Called both
 * when the rep returns from onboarding (immediate UI feedback) and from the
 * account.updated webhook (durable source of truth — return_url firing does
 * NOT guarantee onboarding actually completed).
 */
export async function refreshConnectStatus(tenantId: string): Promise<void> {
  const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId } });
  if (!profile?.stripeConnectAccountId) return;

  const account = await getStripe().accounts.retrieve(profile.stripeConnectAccountId);

  await prisma.salesRepProfile.update({
    where: { tenantId },
    data: {
      stripeConnectChargesEnabled: !!account.charges_enabled,
      stripeConnectPayoutsEnabled: !!account.payouts_enabled,
      stripeConnectDetailsSubmitted: !!account.details_submitted,
      stripeConnectUpdatedAt: new Date(),
    },
  });
}

/** Same lookup as refreshConnectStatus, but routed from the webhook by Connect account id rather than tenantId. */
export async function refreshConnectStatusByAccountId(accountId: string): Promise<void> {
  const profile = await prisma.salesRepProfile.findFirst({ where: { stripeConnectAccountId: accountId } });
  if (!profile) return;
  await refreshConnectStatus(profile.tenantId);
}

/** Lets an already-onboarded rep jump straight into Stripe's own Express dashboard to manage their bank details. */
export async function createExpressDashboardLoginLink(tenantId: string): Promise<string> {
  const profile = await requireActiveSalesRep(tenantId);
  if (!profile.stripeConnectAccountId || !profile.stripeConnectPayoutsEnabled) {
    throw new Error('Payout account is not fully set up yet.');
  }
  const link = await getStripe().accounts.createLoginLink(profile.stripeConnectAccountId);
  return link.url;
}

class StripePayoutError extends Error {}

/**
 * Actually pays a rep: transfers the payout's totalCents from the platform's
 * Stripe balance to their connected account. Admin-only — called from the
 * admin payout review PATCH route's markPaid action.
 */
export async function payRepViaStripeTransfer(payoutId: string, paidBy: string): Promise<void> {
  const payout = await prisma.salesRepPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status === 'paid') throw new StripePayoutError('Payout is already marked paid.');

  const profile = await prisma.salesRepProfile.findUniqueOrThrow({ where: { tenantId: payout.salesRepId } });
  if (!profile.stripeConnectAccountId) {
    throw new StripePayoutError('This rep has not started Stripe payout setup yet.');
  }
  if (!profile.stripeConnectPayoutsEnabled) {
    throw new StripePayoutError('This rep has not finished Stripe verification yet — payouts are not enabled on their account.');
  }

  let transferId: string;
  try {
    const transfer = await getStripe().transfers.create({
      currency: 'usd',
      amount: payout.totalCents,
      destination: profile.stripeConnectAccountId,
      description: `Commission payout ${payout.invoiceNumber}`,
      metadata: { payoutId: payout.id, salesRepId: payout.salesRepId, invoiceNumber: payout.invoiceNumber },
    });
    transferId = transfer.id;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'balance_insufficient') {
      throw new StripePayoutError('Platform Stripe balance is insufficient to cover this transfer.');
    }
    if (code === 'transfers_not_allowed' || code === 'payouts_not_allowed') {
      throw new StripePayoutError("This rep's Stripe account cannot receive transfers right now.");
    }
    throw err;
  }

  await prisma.salesRepPayout.update({
    where: { id: payoutId },
    data: {
      status: 'paid',
      paidAt: new Date(),
      paidBy,
      payoutMethod: 'stripe',
      stripeTransferId: transferId,
    },
  });
}

export { StripePayoutError };
