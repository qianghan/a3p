/**
 * One-off production activation for CA-4 (CAD core-plan pricing).
 *
 * CA-4's code (region field on CorePlanPrice, CAD rows in CORE_PLANS, region
 * threaded through the plan/subscribe routes) is already merged to main.
 * This script performs the remaining one-time production steps:
 *   1. Upsert all CORE_PLANS rows (both us and ca) into BillPlan — same as
 *      agentbook/seed-billing-plans.ts, run here so the ca rows exist before
 *      we attach Stripe IDs to them.
 *   2. For each ca-region paid plan (pro, pro_yearly, business — free has no
 *      Stripe object, matching how us/free already works), create a live
 *      Stripe Product + Price and attach the IDs to that BillPlan row.
 *
 * Safe to re-run: seeding is an upsert, and Stripe attachment is skipped for
 * any ca plan that already has a stripeProductId.
 *
 * Usage: npx tsx agentbook/activate-ca4-cad-pricing.ts
 */
import Stripe from 'stripe';
import { prisma } from '@naap/database';
import { CORE_PLANS } from '@agentbook/pricing';

const PLAN_DETAILS: Record<string, {
  description: string;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
}> = {
  free: {
    description: 'Get started — no commitment.',
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
  },
  pro: {
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  pro_yearly: {
    description: 'Everything in Pro, billed annually — save 20% vs. monthly.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  business: {
    description: 'Unlimited everything. Team seats included.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
  },
};

function requireLiveKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY is not a live-mode key (sk_live_*/rk_live_*) — refusing to create test-mode products under a "production activation" script');
  }
  return key;
}

async function main() {
  const stripe = new Stripe(requireLiveKey());

  console.log('Step 1: seeding BillPlan rows for all CORE_PLANS (us + ca)...\n');
  for (const plan of CORE_PLANS) {
    const details = PLAN_DETAILS[plan.code];
    const data = {
      code: plan.code,
      region: plan.region,
      name: plan.name,
      description: details.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      features: details.features,
      quotas: details.quotas,
      sortOrder: plan.sortOrder,
    };
    await prisma.billPlan.upsert({
      where: { code_region: { code: plan.code, region: plan.region } },
      create: { ...data, isActive: true },
      update: { ...data, isActive: true },
    });
    const price = plan.priceCents === 0 ? 'Free' : `$${(plan.priceCents / 100).toFixed(2)}/${plan.interval === 'year' ? 'yr' : 'mo'}`;
    console.log(`  seeded ${plan.name} [${plan.region}] (${price})`);
  }

  console.log('\nStep 2: creating live Stripe CAD products/prices for paid ca plans...\n');
  const caPaidPlans = await prisma.billPlan.findMany({
    where: { region: 'ca', priceCents: { gt: 0 }, isActive: true },
    orderBy: { sortOrder: 'asc' },
  });

  for (const plan of caPaidPlans) {
    if (plan.stripeProductId && plan.stripePriceId) {
      console.log(`  skip ${plan.name} [${plan.code}/ca] — already has Stripe IDs (${plan.stripeProductId})`);
      continue;
    }
    const product = await stripe.products.create({
      name: `${plan.name} (CAD)`,
      metadata: { code: plan.code, region: 'ca' },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.priceCents,
      currency: plan.currency,
      recurring: { interval: plan.interval as 'month' | 'year' },
    });
    await prisma.billPlan.update({
      where: { id: plan.id },
      data: { stripeProductId: product.id, stripePriceId: price.id },
    });
    console.log(`  created ${plan.name} [${plan.code}/ca] -> product=${product.id} price=${price.id}`);
  }

  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
