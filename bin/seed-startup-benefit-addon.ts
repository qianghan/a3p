import { prisma as db } from '@naap/database';

const ADDON_CODE = 'startup_tax_benefits';

interface Tier { tier: string; priceCents: number; maxSlots: number | null }

// Same nominal number across currencies — the pricing research found no
// reliable evidence for a specific regional discount, so this launches at
// parity and can be corrected later from real conversion data via
// BillAddOnPrice rows, with zero code changes.
const DEFAULT_TIERS: Tier[] = [
  { tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
  { tier: 'standard', priceCents: 24900, maxSlots: null },
  { tier: 'scaled', priceCents: 49900, maxSlots: null },
];

const REGIONS: { region: string; currency: string; tiers: Tier[] }[] = [
  { region: 'us', currency: 'usd', tiers: DEFAULT_TIERS },
  { region: 'ca', currency: 'cad', tiers: DEFAULT_TIERS },
  { region: 'uk', currency: 'gbp', tiers: DEFAULT_TIERS },
  {
    region: 'au',
    currency: 'aud',
    // Unlike the other regions, AUD pricing was independently researched
    // rather than using flat nominal parity — comped against AU R&D tax
    // consultants (10-25% contingency or $5K-$25K+ flat fee per claim) and
    // AU SaaS pricing norms (a modest ~1.2x uplift over the USD figure,
    // not a full ~1.5x spot-rate conversion, since AU buyers benchmark
    // against round nominal ladder points more than FX precision).
    tiers: [
      { tier: 'founding_member', priceCents: 12900, maxSlots: 250 },
      { tier: 'standard', priceCents: 29900, maxSlots: null },
      { tier: 'scaled', priceCents: 59900, maxSlots: null },
    ],
  },
];

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
