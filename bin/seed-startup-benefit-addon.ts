import { prisma as db } from '@naap/database';
import { ADDON_PRICES } from '@agentbook/pricing';

const ADDON_CODE = 'startup_tax_benefits';

interface Tier { tier: string; priceCents: number; maxSlots: number | null }

const REGIONS: { region: string; currency: string; tiers: Tier[] }[] = ['us', 'ca', 'uk', 'au'].map((region) => ({
  region,
  currency: ADDON_PRICES[ADDON_CODE].find((r) => r.region === region)!.currency,
  tiers: ADDON_PRICES[ADDON_CODE]
    .filter((r) => r.region === region)
    .map(({ tier, priceCents, maxSlots }) => ({ tier, priceCents, maxSlots })),
}));

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Startup Tax Benefits', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Startup Tax Benefits', interval: 'year', isActive: true },
  });

  let created = 0;
  let updated = 0;
  let total = 0;

  for (const { region, currency, tiers } of REGIONS) {
    for (const { tier, priceCents, maxSlots } of tiers) {
      total++;
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

  console.log(JSON.stringify({ addOnId: addOn.id, created, updated, total }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
