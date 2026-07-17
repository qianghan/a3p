import { prisma as db } from '@naap/database';
import { ADDON_PRICES } from '@agentbook/pricing';

/**
 * Seeds the "Tax Fast-Track" add-on ($49/yr) that gates /start and
 * /regenerate on the tax fast-track questionnaire (PR-5). Same $49 USD /
 * $65 CAD / $59 AUD precedent as personal_insights and student_success.
 *
 * AU price follows seed-startup-benefit-addon.ts's established convention:
 * a ~1.2x uplift over the USD figure rather than a full ~1.5x FX
 * conversion, rounded to a clean nominal price point. Closes the gap
 * where PR-7 shipped a fully working AuTaxQuestionnairePack/
 * AuFilingDraftPack with no AU price to actually gate behind.
 *
 * Unlike bin/seed-personal-insights-addon.ts, this seeds isActive:true
 * directly rather than defaulting to false with a separate ACTIVATE
 * toggle — that pattern exists for features being gated from day one
 * (register the add-on before the gated route/UI ship). Tax fast-track
 * has already been live and free for two PRs; the gate and the addon
 * go live together, in the same deploy — there is no safe "registered
 * but not yet purchasable" staging period to model here, since hasAddOn()
 * checks isActive before subscription status, and seeding inactive would
 * deny every tenant permanently with no purchase path once the gate ships.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-tax-fast-track-addon.ts
 */

const ADDON_CODE = 'tax_fast_track';

const PRICES = ADDON_PRICES[ADDON_CODE].map(({ region, currency, priceCents }) => ({ region, currency, priceCents }));

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Tax Fast-Track', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Tax Fast-Track', interval: 'year', isActive: true },
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

  console.log(JSON.stringify({ addOnId: addOn.id, isActive: true, created, updated, total: PRICES.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
