/**
 * Invoice card-collection via Stripe Connect.
 *
 * The freelancer connects their OWN Stripe Express account; a client paying an
 * invoice checks out on the platform and the funds are transferred to the
 * freelancer's connected account (a "destination charge" via
 * transfer_data.destination) — so the money reaches the freelancer, not the
 * platform. Mirrors the sales-rep Connect flow (lib/billing/sales-rep-connect).
 *
 * The webhook (agentbook/stripe-webhook/handlers) marks the invoice paid when
 * checkout.session.completed arrives with our invoiceId metadata.
 */

import 'server-only';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';

const JURISDICTION_TO_COUNTRY: Record<string, string> = { us: 'US', ca: 'CA', uk: 'GB', au: 'AU' };

async function countryForTenant(tenantId: string): Promise<string> {
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  return JURISDICTION_TO_COUNTRY[(cfg?.jurisdiction ?? 'us').toLowerCase()] ?? 'US';
}

/** Get-or-create the tenant's Connect Express account for receiving invoice payments. Idempotent. */
export async function getOrCreateInvoiceAccount(tenantId: string): Promise<string> {
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  if (cfg?.stripeInvoiceAccountId) return cfg.stripeInvoiceAccountId;

  const user = await prisma.user.findUnique({ where: { id: tenantId }, select: { email: true } });
  const account = await getStripe().accounts.create({
    type: 'express',
    country: await countryForTenant(tenantId),
    email: user?.email ?? undefined,
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    business_type: 'individual',
    metadata: { tenantId, purpose: 'invoice_payments' },
  });

  await prisma.abTenantConfig.update({ where: { userId: tenantId }, data: { stripeInvoiceAccountId: account.id } });
  return account.id;
}

/** Stripe-hosted onboarding link (new account or resume incomplete). */
export async function createInvoiceOnboardingLink(tenantId: string, returnUrl: string, refreshUrl: string): Promise<string> {
  const accountId = await getOrCreateInvoiceAccount(tenantId);
  const link = await getStripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return link.url;
}

export interface InvoiceConnectStatus {
  connected: boolean;      // an account exists
  payoutsEnabled: boolean; // onboarding done + can receive funds
  accountId: string | null;
}

/** Pull latest account status from Stripe and persist `payoutsEnabled`. */
export async function refreshInvoiceConnectStatus(tenantId: string): Promise<InvoiceConnectStatus> {
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  if (!cfg?.stripeInvoiceAccountId) return { connected: false, payoutsEnabled: false, accountId: null };

  const account = await getStripe().accounts.retrieve(cfg.stripeInvoiceAccountId);
  const payoutsEnabled = !!account.payouts_enabled;
  await prisma.abTenantConfig.update({ where: { userId: tenantId }, data: { stripeInvoicePayoutsEnabled: payoutsEnabled } });
  return { connected: true, payoutsEnabled, accountId: cfg.stripeInvoiceAccountId };
}

export class InvoicePayLinkError extends Error {}

/**
 * Create a Stripe Checkout link for a client to pay an invoice by card. The
 * charge settles to the freelancer's connected account (destination charge).
 * Sets invoice.paymentUrl and returns it. Requires the tenant's Connect
 * account to be onboarded (payouts enabled).
 */
export async function createInvoicePayLink(invoiceId: string, tenantId: string, appBaseUrl: string): Promise<string> {
  const invoice = await prisma.abInvoice.findFirst({ where: { id: invoiceId, tenantId }, include: { payments: true } });
  if (!invoice) throw new InvoicePayLinkError('Invoice not found.');
  if (invoice.status === 'paid') throw new InvoicePayLinkError('Invoice is already paid.');
  if (invoice.status === 'void') throw new InvoicePayLinkError('Cannot collect on a voided invoice.');

  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  if (!cfg?.stripeInvoiceAccountId || !cfg.stripeInvoicePayoutsEnabled) {
    throw new InvoicePayLinkError('Connect a payout account (Settings → Payments) before collecting card payments.');
  }

  const paid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const remaining = invoice.amountCents - paid;
  if (remaining <= 0) throw new InvoicePayLinkError('Nothing left to pay on this invoice.');

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: (invoice.currency || 'USD').toLowerCase(),
        product_data: { name: `Invoice ${invoice.number}` },
        unit_amount: remaining,
      },
      quantity: 1,
    }],
    payment_intent_data: { transfer_data: { destination: cfg.stripeInvoiceAccountId } },
    success_url: `${appBaseUrl}/pay/${invoice.id}?paid=1`,
    cancel_url: `${appBaseUrl}/pay/${invoice.id}`,
    metadata: { invoiceId: invoice.id, tenantId, kind: 'invoice_payment' },
  });

  const url = session.url;
  if (!url) throw new InvoicePayLinkError('Stripe did not return a checkout URL.');
  await prisma.abInvoice.update({ where: { id: invoice.id }, data: { paymentUrl: url } });
  return url;
}
