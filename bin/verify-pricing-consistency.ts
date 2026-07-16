/**
 * Reads live BillPlan/BillAddOnPrice rows and asserts they match
 * @agentbook/pricing — turns "someone notices a mismatch by reading the
 * site" into an automated, runnable check. Not part of the standard CI
 * unit-test run (this repo's CI jobs don't have a live DB — see the
 * chronic oauth-consent/localhost:5432 issue); run manually after any
 * seed-script change, or wire into a scheduled job later.
 *
 * Usage: DATABASE_URL=<env to check> npx tsx bin/verify-pricing-consistency.ts
 * Exit code 0 = consistent, 1 = drift found (prints every mismatch).
 */
import { prisma } from '@naap/database';
import { CORE_PLANS, ADDON_PRICES } from '@agentbook/pricing';

async function main() {
  const mismatches: string[] = [];

  for (const plan of CORE_PLANS) {
    const row = await prisma.billPlan.findUnique({ where: { code: plan.code } });
    if (!row) {
      mismatches.push(`BillPlan '${plan.code}': no row found in the database`);
      continue;
    }
    if (row.priceCents !== plan.priceCents) {
      mismatches.push(`BillPlan '${plan.code}': DB priceCents=${row.priceCents}, expected ${plan.priceCents}`);
    }
    if (row.currency !== plan.currency) {
      mismatches.push(`BillPlan '${plan.code}': DB currency=${row.currency}, expected ${plan.currency}`);
    }
    if (row.interval !== plan.interval) {
      mismatches.push(`BillPlan '${plan.code}': DB interval=${row.interval}, expected ${plan.interval}`);
    }
  }

  for (const [addOnCode, expectedRows] of Object.entries(ADDON_PRICES)) {
    const addOn = await prisma.billAddOn.findUnique({ where: { code: addOnCode } });
    if (!addOn) {
      mismatches.push(`BillAddOn '${addOnCode}': no row found in the database`);
      continue;
    }
    for (const expected of expectedRows) {
      const row = await prisma.billAddOnPrice.findUnique({
        where: { addOnId_region_tier: { addOnId: addOn.id, region: expected.region, tier: expected.tier } },
      });
      if (!row) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: no row found`);
        continue;
      }
      if (row.priceCents !== expected.priceCents) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: DB priceCents=${row.priceCents}, expected ${expected.priceCents}`);
      }
      if (row.currency !== expected.currency) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: DB currency=${row.currency}, expected ${expected.currency}`);
      }
    }
  }

  if (mismatches.length > 0) {
    console.error(`Found ${mismatches.length} pricing mismatch(es):`);
    for (const m of mismatches) console.error(`  ✗ ${m}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`✓ All ${CORE_PLANS.length} core plans and ${Object.values(ADDON_PRICES).flat().length} add-on prices match @agentbook/pricing.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
