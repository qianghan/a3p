/**
 * Live Stripe activation for ALL core-plan regions (us, ca, au) — generalizes
 * agentbook/activate-ca4-cad-pricing.ts (which only did `ca`) so USD and AUD
 * plans get real Stripe Products/Prices too, closing launch blocker C1 for
 * core plans in every market.
 *
 *   1. Upsert every CORE_PLANS row into BillPlan (upsert — safe to re-run).
 *   2. For each paid plan (any region) with no Stripe IDs, create a live
 *      Stripe Product + Price and attach the IDs. Free plans are skipped
 *      (no Stripe object), and any plan that already has a stripeProductId is
 *      skipped — so this is idempotent and safe to re-run.
 *
 * Requires a LIVE Stripe key; refuses a test-mode key under a production
 * activation script. The key is read from the environment and never logged.
 *
 * Usage: STRIPE_SECRET_KEY=sk_live_… npx tsx agentbook/activate-core-plan-pricing.ts
 */
import Stripe from 'stripe';
import { prisma } from '@naap/database';
import { CORE_PLANS } from '@agentbook/pricing';

const CURRENCY_LABEL: Record<string, string> = { usd: 'USD', cad: 'CAD', aud: 'AUD', gbp: 'GBP' };

// features/quotas are required (non-null Json) on BillPlan. Same per-code detail
// map as activate-ca4-cad-pricing.ts — keyed by plan code, shared across regions.
const PLAN_DETAILS: Record<string, { description: string; features: Record<string, boolean>; quotas: Record<string, number> }> = {
  free: { description: 'Get started — no commitment.', features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false }, quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 } },
  pro: { description: 'Telegram bot, tax exports, generous quotas for active solo users.', features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false }, quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 } },
  pro_yearly: { description: 'Everything in Pro, billed annually — save 20% vs. monthly.', features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false }, quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 } },
  business: { description: 'Unlimited everything. Team seats included.', features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true }, quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 } },
};

function requireLiveKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY is not a live-mode key (sk_live_*/rk_live_*) — refusing to create test-mode products under a production activation script');
  }
  return key;
}

async function main() {
  const stripe = new Stripe(requireLiveKey());

  console.log('Step 1: upserting BillPlan rows for all CORE_PLANS (us + ca + au)…\n');
  for (const plan of CORE_PLANS) {
    const d = PLAN_DETAILS[plan.code] ?? { description: plan.name, features: {}, quotas: {} };
    const data = {
      code: plan.code, region: plan.region, name: plan.name, description: d.description,
      priceCents: plan.priceCents, currency: plan.currency, interval: plan.interval,
      features: d.features, quotas: d.quotas, sortOrder: plan.sortOrder,
    };
    await prisma.billPlan.upsert({
      where: { code_region: { code: plan.code, region: plan.region } },
      create: { ...data, isActive: true },
      update: { ...data, isActive: true },
    });
  }

  console.log('Step 2: creating live Stripe products/prices for every paid plan without Stripe IDs…\n');
  const paidPlans = await prisma.billPlan.findMany({
    where: { priceCents: { gt: 0 }, isActive: true },
    orderBy: [{ region: 'asc' }, { sortOrder: 'asc' }],
  });

  let created = 0, skipped = 0;
  for (const plan of paidPlans) {
    if (plan.stripeProductId && plan.stripePriceId) {
      console.log(`  skip ${plan.name} [${plan.code}/${plan.region}] — already has Stripe IDs`);
      skipped++;
      continue;
    }
    const ccy = CURRENCY_LABEL[plan.currency.toLowerCase()] || plan.currency.toUpperCase();
    const product = await stripe.products.create({
      name: `${plan.name} (${ccy})`,
      metadata: { code: plan.code, region: plan.region },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.priceCents,
      currency: plan.currency.toLowerCase(),
      recurring: { interval: plan.interval as 'month' | 'year' },
    });
    await prisma.billPlan.update({ where: { id: plan.id }, data: { stripeProductId: product.id, stripePriceId: price.id } });
    console.log(`  created ${plan.name} [${plan.code}/${plan.region}] -> product=${product.id} price=${price.id}`);
    created++;
  }

  console.log(`\nDone. created=${created}, skipped(existing)=${skipped}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
