import { prisma as db } from '@naap/database';

const ADDON_CODE = 'startup_tax_benefits';

const REGIONS: { region: string; currency: string }[] = [
  { region: 'us', currency: 'usd' },
  { region: 'ca', currency: 'cad' },
  { region: 'uk', currency: 'gbp' },
];

// Same nominal number across currencies — the pricing research found no
// reliable evidence for a specific regional discount, so this launches at
// parity and can be corrected later from real conversion data via
// BillAddOnPrice rows, with zero code changes.
const TIERS: { tier: string; priceCents: number; maxSlots: number | null }[] = [
  { tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
  { tier: 'standard', priceCents: 24900, maxSlots: null },
  { tier: 'scaled', priceCents: 49900, maxSlots: null },
];

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Startup Tax Benefits', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Startup Tax Benefits', interval: 'year', isActive: true },
  });

  let created = 0;
  let updated = 0;

  for (const { region, currency } of REGIONS) {
    for (const { tier, priceCents, maxSlots } of TIERS) {
      const existing = await db.billAddOnPrice.findUnique({
        where: { addOnId_region_tier: { addOnId: addOn.id, region, tier } },
      });
      const data = { addOnId: addOn.id, region, currency, tier, priceCents, maxSlots, isActive: true };
      if (existing) {
        await db.billAddOnPrice.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await db.billAddOnPrice.create({ data });
        created++;
      }
    }
  }

  console.log(JSON.stringify({ addOnId: addOn.id, created, updated, total: REGIONS.length * TIERS.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
