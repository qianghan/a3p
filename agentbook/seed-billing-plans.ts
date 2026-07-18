/**
 * Seeds default billing plans (Free, Pro, Pro Annual, Business) into the
 * database. Safe to re-run — uses upsert. Price/currency/interval come
 * from @agentbook/pricing (the shared source of truth); only
 * name/description/features/quotas — business logic, not pricing — stay
 * defined here.
 *
 * Usage: npx tsx agentbook/seed-billing-plans.ts
 */
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
    // Same tier as Pro monthly — annual is a billing-interval choice, not a
    // different feature/quota tier.
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  business: {
    description: 'Unlimited everything. Team seats included.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
  },
};

async function main() {
  console.log('Seeding billing plans...\n');
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
    // code is no longer globally unique (see @@unique([code, region])) — the
    // upsert must key on the compound unique index Prisma generates for it.
    await prisma.billPlan.upsert({
      where: { code_region: { code: plan.code, region: plan.region } },
      create: { ...data, isActive: true },
      update: { ...data, isActive: true },
    });
    const price = plan.priceCents === 0 ? 'Free' : `$${(plan.priceCents / 100).toFixed(2)}/${plan.interval === 'year' ? 'yr' : 'mo'}`;
    console.log(`  ✓ ${plan.name} [${plan.region}] (${price})`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
