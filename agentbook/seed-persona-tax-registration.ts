/**
 * Persona definition: sydney (AU) and maya (CA) are GST/HST registrants.
 * Sets AbTenantConfig.gstRegistered = true for those two persona tenants ONLY,
 * touching no other field. Idempotent. Dry-run by default; pass --apply to write.
 * The prod e2e tests/e2e/mobile-app/tax-codes.spec.ts fails until this has run.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/seed-persona-tax-registration.ts           # dry run
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/seed-persona-tax-registration.ts --apply   # write
 */

import { prisma as db } from '@naap/database';

const REGISTRANTS = ['sydney@agentbook.test', 'maya@agentbook.test'] as const;

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'APPLY: setting gstRegistered=true\n' : 'DRY RUN (pass --apply to write)\n');
  for (const email of REGISTRANTS) {
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) { console.log(`  ✗ ${email}: no user, skipped`); continue; }
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: user.id }, select: { gstRegistered: true } });
    if (!cfg) { console.log(`  ✗ ${email} (${user.id}): no tenant config, skipped`); continue; }
    const before = cfg.gstRegistered;
    if (before === true) { console.log(`  = ${email}: gstRegistered already true`); continue; }
    if (apply) {
      await db.abTenantConfig.update({ where: { userId: user.id }, data: { gstRegistered: true } });
      const after = (await db.abTenantConfig.findUnique({ where: { userId: user.id }, select: { gstRegistered: true } }))?.gstRegistered;
      console.log(`  ✓ ${email}: gstRegistered ${String(before)} -> ${String(after)}`);
    } else {
      console.log(`  ~ ${email}: gstRegistered ${String(before)} -> true (would change)`);
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
