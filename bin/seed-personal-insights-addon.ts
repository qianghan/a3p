import { prisma as db } from '@naap/database';

/**
 * Seeds the "Personal Insights" add-on ($49/yr) that gates the personal-
 * finance net-worth trend chart and proactive nudges (budget-threshold,
 * net-worth month-over-month, negative savings rate). Mirrors
 * seed-student-success-addon.ts deliberately: ONE tier ('standard') and only
 * US + CA, same $49 USD / $65 CAD precedent — no new pricing decision here.
 *
 * Seeded isActive:false on purpose — the add-on is registered but NOT
 * purchasable until the gated trend route/UI ship. Re-run with ACTIVATE=1
 * to flip it live at that point (idempotent upsert either way).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-personal-insights-addon.ts          # inactive
 *   ACTIVATE=1 DATABASE_URL=... npx tsx bin/seed-personal-insights-addon.ts # active
 */

const ADDON_CODE = 'personal_insights';
const ACTIVATE = process.env.ACTIVATE === '1';

// $49 USD / $65 CAD, single tier — matches the student_success precedent.
const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
];

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Personal Insights', interval: 'year', isActive: ACTIVATE },
    create: { code: ADDON_CODE, name: 'Personal Insights', interval: 'year', isActive: ACTIVATE },
  });

  let created = 0;
  let updated = 0;
  for (const { region, currency, priceCents } of PRICES) {
    const existing = await db.billAddOnPrice.findUnique({
      where: { addOnId_region_tier: { addOnId: addOn.id, region, tier: 'standard' } },
    });
    const data = { addOnId: addOn.id, region, currency, tier: 'standard', priceCents, maxSlots: null, isActive: true };
    if (existing) {
      await db.billAddOnPrice.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.billAddOnPrice.create({ data });
      created++;
    }
  }

  console.log(JSON.stringify({ addOnId: addOn.id, isActive: ACTIVATE, created, updated, total: PRICES.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
