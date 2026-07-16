import { prisma as db } from '@naap/database';

/**
 * Seeds the "Student Success" add-on ($49/yr) that gates the three student
 * plugins (Scholarship, Career/Co-op, Housing). Mirrors
 * seed-startup-benefit-addon.ts but deliberately simpler: ONE tier
 * ('standard'), now US + CA + AU, per the confirmed product decision — a
 * student add-on wants one obvious price, not a founding/scaled ladder.
 *
 * AU price follows seed-startup-benefit-addon.ts's established convention:
 * a ~1.2x uplift over the USD figure rather than a full ~1.5x FX
 * conversion, rounded to a clean nominal price point.
 *
 * Seeded isActive:false on purpose — the add-on is registered but NOT
 * purchasable until the first gated plugin (Scholarship) ships and is added
 * to PLUGIN_REQUIRED_ADDON. Re-run with ACTIVATE=1 to flip it live at that
 * point (idempotent upsert either way).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-student-success-addon.ts          # inactive
 *   ACTIVATE=1 DATABASE_URL=... npx tsx bin/seed-student-success-addon.ts # active
 */

const ADDON_CODE = 'student_success';
const ACTIVATE = process.env.ACTIVATE === '1';

// $49 USD / $65 CAD / $59 AUD, single tier. Nominal-parity elsewhere can be
// added as more BillAddOnPrice rows later with zero code changes.
const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
  { region: 'au', currency: 'aud', priceCents: 5900 },
];

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Student Success', interval: 'year', isActive: ACTIVATE },
    create: { code: ADDON_CODE, name: 'Student Success', interval: 'year', isActive: ACTIVATE },
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
