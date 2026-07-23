/**
 * Grant a COMPED (free, no-Stripe) active `student_success` add-on subscription
 * to one existing account — for QA / demo / support comps while Student Success
 * stays a PAID add-on for real users.
 *
 * This does NOT change the paid gate or the add-on product; it only inserts a
 * single BillAddOnSubscription with status='active' for the named tenant, the
 * same shape the Stripe webhook would create after a real purchase. Generalizes
 * bin/seed-student-chat-test-account.ts (which is hard-coded to taylor-student)
 * so any account you're testing with can be unblocked without a live Stripe key.
 *
 * Prerequisites (already true once the add-on is seeded — see
 * bin/seed-student-success-addon.ts): the `student_success` BillAddOn exists and
 * isActive=true, and at least one BillAddOnPrice row exists. Stripe activation
 * (stripePriceId) is NOT required for a comp.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/comp-student-addon.ts <email-or-tenantId> [tier]
 *   # tier defaults to 'standard'; falls back to any price row if that tier is absent.
 */

import { prisma as db } from '@naap/database';

const ADDON_CODE = 'student_success';

async function main() {
  const arg = process.argv[2];
  const wantTier = process.argv[3] || 'standard';
  if (!arg) {
    console.error('Usage: npx tsx bin/comp-student-addon.ts <email-or-tenantId> [tier]');
    process.exit(1);
  }

  // Resolve the tenant/account id from an email or a raw id.
  const user = arg.includes('@')
    ? await db.user.findUnique({ where: { email: arg }, select: { id: true, email: true } })
    : await db.user.findUnique({ where: { id: arg }, select: { id: true, email: true } });
  if (!user) throw new Error(`No user found for "${arg}"`);
  const accountId = user.id;

  const addOn = await db.billAddOn.findUnique({ where: { code: ADDON_CODE } });
  if (!addOn) throw new Error(`${ADDON_CODE} add-on not found — run bin/seed-student-success-addon.ts first`);
  if (!addOn.isActive) throw new Error(`${ADDON_CODE} add-on is not active in this environment (set isActive=true)`);

  // Prefer the requested tier's price; fall back to any price row so a comp
  // never fails just because the tier naming differs across environments.
  const price =
    (await db.billAddOnPrice.findFirst({ where: { addOnId: addOn.id, tier: wantTier } })) ||
    (await db.billAddOnPrice.findFirst({ where: { addOnId: addOn.id } }));
  if (!price) throw new Error(`No BillAddOnPrice for ${ADDON_CODE} — run bin/seed-student-success-addon.ts first`);

  const sub = await db.billAddOnSubscription.upsert({
    where: { accountId_addOnId: { accountId, addOnId: addOn.id } },
    create: { accountId, addOnId: addOn.id, priceId: price.id, status: 'active' },
    update: { status: 'active', priceId: price.id, canceledAt: null },
  });

  console.log(JSON.stringify({
    comped: ADDON_CODE, account: accountId, email: user.email,
    tier: price.tier, subscriptionId: sub.id, status: 'active',
  }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
