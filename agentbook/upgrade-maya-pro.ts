/**
 * Upserts billing plans and upgrades Maya to Pro.
 * Usage: DATABASE_URL=... DATABASE_URL_UNPOOLED=... npx tsx agentbook/upgrade-maya-pro.ts
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
];

async function main() {
  // 1. Upsert plans
  console.log('Upserting billing plans...');
  for (const p of PLANS) {
    await (prisma as any).billPlan.upsert({
      where: { code: p.code },
      create: { ...p, isActive: true },
      update: { ...p, isActive: true },
    });
    console.log(`  ✓ ${p.name}`);
  }

  // 2. Find Maya
  const maya = await prisma.user.findFirst({ where: { email: 'maya@agentbook.test' } });
  if (!maya) {
    console.error('Maya user not found! Run seed-users.ts first.');
    process.exit(1);
  }
  console.log(`\nMaya found: ${maya.id}`);

  // 3. Get Pro plan
  const proPlan = await (prisma as any).billPlan.findUnique({ where: { code: 'pro' } });
  if (!proPlan) throw new Error('Pro plan not found after upsert');

  // 4. Upsert subscription
  const now = new Date();
  const yearEnd = new Date(now);
  yearEnd.setFullYear(yearEnd.getFullYear() + 1);

  const sub = await (prisma as any).billSubscription.upsert({
    where: { accountId: maya.id },
    create: {
      accountId: maya.id,
      planId: proPlan.id,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: yearEnd,
      cancelAtPeriodEnd: false,
    },
    update: {
      planId: proPlan.id,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: yearEnd,
      cancelAtPeriodEnd: false,
    },
  });
  console.log(`\n✅ Maya (${maya.id}) → Pro plan until ${yearEnd.toISOString().slice(0, 10)}`);
  console.log(`   Subscription ID: ${sub.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
