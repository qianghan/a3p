/**
 * One-off script: creates the real Stripe Price + BillPlan row for
 * "Pro Annual" ($182/yr), which did not exist as a purchasable product
 * before this script ran (the marketing page advertised it, but there was
 * no BillPlan row, no Stripe Price, and no code anywhere that read the
 * `?plan=pro-yearly` query param the marketing CTA links to).
 *
 * Reuses the EXISTING Stripe Product behind the monthly 'pro' BillPlan —
 * annual is a second Price on the same Product, the idiomatic Stripe
 * modeling for "same plan, different billing interval" (not a new Product).
 *
 * Usage (run once against production):
 *   DATABASE_URL=<prod> STRIPE_SECRET_KEY=<prod live key> npx tsx bin/create-pro-yearly-plan.ts
 *
 * Idempotent: re-running finds the already-created BillPlan row by code
 * and skips creating a duplicate Stripe Price if stripePriceId is already
 * set.
 */
import { prisma } from '@naap/database';
import Stripe from 'stripe';
import { CORE_PLANS } from '@agentbook/pricing';

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY must be set');
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion });

  const proYearly = CORE_PLANS.find((p) => p.code === 'pro_yearly');
  if (!proYearly) throw new Error('pro_yearly not found in @agentbook/pricing CORE_PLANS');

  const existing = await prisma.billPlan.findUnique({ where: { code: 'pro_yearly' } });
  if (existing?.stripePriceId) {
    console.log(JSON.stringify({ skipped: true, reason: 'already has a stripePriceId', billPlanId: existing.id, stripePriceId: existing.stripePriceId }));
    await prisma.$disconnect();
    return;
  }

  const monthlyPro = await prisma.billPlan.findUnique({ where: { code: 'pro' } });
  if (!monthlyPro?.stripeProductId) {
    throw new Error('the monthly "pro" BillPlan has no stripeProductId — cannot attach an annual Price to it');
  }

  const price = await stripe.prices.create({
    product: monthlyPro.stripeProductId,
    unit_amount: proYearly.priceCents,
    currency: proYearly.currency,
    recurring: { interval: 'year' },
    nickname: 'Pro Annual',
  });

  const billPlan = await prisma.billPlan.upsert({
    where: { code: 'pro_yearly' },
    create: {
      code: 'pro_yearly',
      name: proYearly.name,
      description: 'Everything in Pro, billed annually — save 20% vs. monthly.',
      priceCents: proYearly.priceCents,
      currency: proYearly.currency,
      interval: proYearly.interval,
      stripeProductId: monthlyPro.stripeProductId,
      stripePriceId: price.id,
      features: monthlyPro.features as object,
      quotas: monthlyPro.quotas as object,
      sortOrder: proYearly.sortOrder,
      isActive: true,
    },
    update: {
      stripeProductId: monthlyPro.stripeProductId,
      stripePriceId: price.id,
    },
  });

  console.log(JSON.stringify({ created: true, billPlanId: billPlan.id, stripeProductId: monthlyPro.stripeProductId, stripePriceId: price.id }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
