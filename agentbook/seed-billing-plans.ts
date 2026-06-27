/**
 * Seeds default billing plans (Free, Pro, Business) into the database.
 * Safe to re-run — uses upsert.
 *
 * Usage: npx tsx agentbook/seed-billing-plans.ts
 */
import { prisma } from '@naap/database';

const PLANS = [
  {
    code: 'free',
    name: 'Free',
    description: 'Get started — no commitment.',
    priceCents: 0,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
    sortOrder: 0,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    priceCents: 1900,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
    sortOrder: 1,
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Unlimited everything. Team seats included.',
    priceCents: 4900,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
    sortOrder: 2,
  },
];

async function main() {
  console.log('Seeding billing plans...\n');
  for (const p of PLANS) {
    await prisma.billPlan.upsert({
      where: { code: p.code },
      create: { ...p, isActive: true },
      update: { ...p, isActive: true },
    });
    const price = p.priceCents === 0 ? 'Free' : `$${(p.priceCents / 100).toFixed(0)}/mo`;
    console.log(`  ✓ ${p.name} (${price})`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
