import 'server-only';
import { prisma } from '@naap/database';
import { invalidateAccount } from '@naap/billing';
import { processInviteePaid, applyPendingCredits } from '@/lib/billing/referrals';
import type Stripe from 'stripe';

export async function applyEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) {
        console.warn('[stripe-webhook] subscription missing tenantId metadata, skipping');
        return;
      }

      const addOnCode = sub.metadata?.addOnCode as string | undefined;
      if (addOnCode) {
        const priceIdMeta = sub.metadata?.priceId as string | undefined;
        const price = priceIdMeta
          ? await prisma.billAddOnPrice.findUnique({ where: { id: priceIdMeta } })
          : null;
        if (!price) {
          console.error('[stripe-webhook] add-on price not found for priceId', priceIdMeta);
          return;
        }
        const addOnCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        await prisma.billAddOnSubscription.upsert({
          where: { accountId_addOnId: { accountId: tenantId, addOnId: price.addOnId } },
          create: {
            accountId: tenantId, addOnId: price.addOnId, priceId: price.id,
            status: sub.status, stripeCustomerId: addOnCustomerId, stripeSubscriptionId: sub.id,
          },
          update: {
            priceId: price.id, status: sub.status, stripeSubscriptionId: sub.id, canceledAt: null,
          },
        });
        return;
      }

      const priceId = sub.items.data[0]?.price.id;
      const plan = priceId
        ? await prisma.billPlan.findFirst({ where: { stripePriceId: priceId } })
        : null;
      if (!plan) {
        console.error('[stripe-webhook] plan not found for stripePriceId', priceId);
        return;
      }
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const startSec = (sub as unknown as { current_period_start: number }).current_period_start;
      const endSec = (sub as unknown as { current_period_end: number }).current_period_end;
      await prisma.billSubscription.upsert({
        where: { accountId: tenantId },
        create: {
          accountId: tenantId,
          planId: plan.id,
          status: sub.status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          currentPeriodStart: new Date(startSec * 1000),
          currentPeriodEnd: new Date(endSec * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
        update: {
          planId: plan.id,
          status: sub.status,
          stripeSubscriptionId: sub.id,
          currentPeriodStart: new Date(startSec * 1000),
          currentPeriodEnd: new Date(endSec * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
      });
      invalidateAccount(tenantId);
      // If this account was invited and is now actively paying, settle its
      // referrer's reward (reliable trigger — tenantId is known here, so it
      // doesn't depend on invoice.paid/subscription event ordering).
      if (sub.status === 'active') {
        try {
          await processInviteePaid(tenantId);
        } catch (e) {
          console.error('[stripe-webhook] processInviteePaid (sub.active) failed', e);
        }
      }
      // Now that this account has a Stripe customer, flush any banked referral
      // credit it earned before subscribing.
      try {
        await applyPendingCredits(tenantId);
      } catch (e) {
        console.error('[stripe-webhook] applyPendingCredits failed', e);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) return;

      const addOnCode = sub.metadata?.addOnCode as string | undefined;
      if (addOnCode) {
        const addOn = await prisma.billAddOn.findUnique({ where: { code: addOnCode } });
        if (!addOn) return;
        await prisma.billAddOnSubscription.update({
          where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
          data: { status: 'canceled', canceledAt: new Date() },
        });
        return;
      }

      await prisma.billSubscription.update({
        where: { accountId: tenantId },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      invalidateAccount(tenantId);
      break;
    }
    case 'invoice.paid': {
      // Subscription status is flipped by customer.subscription.updated.
      // Here we settle referral rewards: if this paying account was invited,
      // credit their referrer 1 free month (idempotent, capped at 12).
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
      if (customerId) {
        const sub = await prisma.billSubscription.findFirst({
          where: { stripeCustomerId: customerId },
          select: { accountId: true },
        });
        if (sub?.accountId) {
          try {
            await processInviteePaid(sub.accountId);
          } catch (e) {
            console.error('[stripe-webhook] processInviteePaid failed', e);
          }
        }
      }
      console.log('[stripe-webhook] invoice.paid recorded');
      break;
    }
    case 'invoice.payment_failed':
      console.log('[stripe-webhook] invoice.payment_failed recorded');
      break;
    case 'checkout.session.completed': {
      // Customer-invoice payment via Stripe Checkout (NOT subscription).
      // Records payment, marks AbInvoice paid, creates journal entry.
      // Previously handled by plugins/agentbook-invoice /stripe/checkout-completed
      // (which was unsigned). Now consolidated into the signed canonical handler.
      const session = event.data.object as Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoiceId;
      const tenantId = session.metadata?.tenantId;
      if (!invoiceId || !tenantId) {
        console.warn('[stripe-webhook] checkout.session.completed missing invoiceId/tenantId metadata');
        return;
      }
      const paymentIntent =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id ?? null;

      // Idempotency: skip if a payment row already exists for this PaymentIntent.
      if (paymentIntent) {
        const existing = await prisma.abPayment.findFirst({ where: { stripePaymentId: paymentIntent } });
        if (existing) return;
      }

      const invoice = await prisma.abInvoice.findFirst({ where: { id: invoiceId, tenantId } });
      if (!invoice || invoice.status === 'paid') return;

      const amountCents = session.amount_total ?? invoice.amountCents;

      await prisma.abPayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amountCents,
          method: 'stripe',
          date: new Date(),
          stripePaymentId: paymentIntent,
        },
      });

      await prisma.abInvoice.update({
        where: { id: invoice.id },
        data: { status: 'paid' },
      });

      // Best-effort journal entry — won't block payment recording if accounts missing.
      try {
        const cashAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1010' } });
        const arAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1200' } });
        if (cashAccount && arAccount) {
          await prisma.abJournalEntry.create({
            data: {
              tenantId,
              date: new Date(),
              memo: `Stripe payment for ${invoice.number}`,
              sourceType: 'payment',
              sourceId: invoice.id,
              lines: {
                create: [
                  { tenantId, accountId: cashAccount.id, debitCents: amountCents, creditCents: 0 }, // G-009
                  { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: amountCents }, // G-009
                ],
              },
            },
          });
        }
      } catch (err) {
        console.warn('[stripe-webhook] journal entry creation failed (non-fatal):', err);
      }

      await prisma.abEvent.create({
        data: {
          tenantId,
          eventType: 'invoice.stripe_payment',
          actor: 'stripe',
          action: { invoiceId: invoice.id, amountCents, paymentIntent },
        },
      });
      break;
    }
    default:
      // Unknown event type — still recorded in BillEvent for replay.
      break;
  }
}
