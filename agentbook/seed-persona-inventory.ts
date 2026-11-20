/**
 * Persona definition (PR 5A): alex (US), maya (CA) and sydney (AU) track
 * inventory. Sets AbTenantConfig.trackInventory = true for those three persona
 * tenants ONLY, touching no other field. Idempotent. Dry-run by default; pass
 * --apply to write. tests/e2e/mobile-app/inventory.spec.ts fails until this ran
 * (it never writes tenant config itself).
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/seed-persona-inventory.ts           # dry run
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/seed-persona-inventory.ts --apply   # write
 */

import { prisma as db } from '@naap/database';

const PERSONAS = ['alex@agentbook.test', 'maya@agentbook.test', 'sydney@agentbook.test'] as const;

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'APPLY: setting trackInventory=true\n' : 'DRY RUN (pass --apply to write)\n');
  for (const email of PERSONAS) {
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) { console.log(`  ✗ ${email}: no user, skipped`); process.exitCode = 1; continue; }
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: user.id }, select: { trackInventory: true } });
    if (!cfg) { console.log(`  ✗ ${email} (${user.id}): no tenant config, skipped`); process.exitCode = 1; continue; }
    if (cfg.trackInventory === true) { console.log(`  = ${email}: trackInventory already true`); continue; }
    if (apply) {
      await db.abTenantConfig.update({ where: { userId: user.id }, data: { trackInventory: true } });
      console.log(`  ✓ ${email}: trackInventory false -> true`);
    } else {
      console.log(`  ~ ${email}: trackInventory false -> true (would change)`);
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
