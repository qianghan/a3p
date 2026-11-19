/**
 * PR 3bc.10 rollout: enable at-entry AP posting (`purchases_at_entry`) for
 * named persona tenants, via the FeatureFlag row's `metadata.tenantIds`
 * allowlist (apps/web-next/src/lib/purchases-flag.ts). Touches only that row.
 * Cash-basis tenants are listed but have no effect (they always post at payment).
 * Dry-run by default; pass --apply to write. Idempotent.
 * The prod e2e tests/e2e/mobile-app/bills.spec.ts fails until this has run.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/enable-purchases-at-entry.ts                       # dry run, personas
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/enable-purchases-at-entry.ts --apply               # write
 *   ... --email someone@example.com [--email ...]      # other tenants instead of the personas
 *   ... --remove                                      # take the listed tenants OUT of the allowlist
 *   ... --global on|off                               # flip the global switch (default-on step of 3bc.10)
 */

import { prisma as db } from '@naap/database';

const KEY = 'purchases_at_entry';
const PERSONAS = ['alex@agentbook.test', 'maya@agentbook.test', 'sydney@agentbook.test'];
/** Legacy control persona: bills.spec.ts proves at_payment on it every run. */
const NEVER_ENABLE = ['jordan@agentbook.test'];

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const remove = process.argv.includes('--remove');
  const global = argValues('--global')[0];
  const emails = argValues('--email').length ? argValues('--email') : PERSONAS;
  console.log(apply ? 'APPLY\n' : 'DRY RUN (pass --apply to write)\n');

  const row = await db.featureFlag.findUnique({ where: { key: KEY } });
  const meta = (row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as { tenantIds?: unknown };
  const before = Array.isArray(meta.tenantIds) ? meta.tenantIds.filter((x): x is string => typeof x === 'string') : [];
  const ids = new Set(before);
  console.log(`  flag ${KEY}: ${row ? `enabled=${row.enabled}` : 'no row'}; allowlist ${before.length} tenant(s)`);

  if (!global) {
    for (const email of emails) {
      if (!remove && NEVER_ENABLE.includes(email)) {
        console.log(`  ✗ ${email}: the legacy at_payment control (tests/e2e/mobile-app/bills.spec.ts), never enabled — skipped`);
        process.exitCode = 1;
        continue;
      }
      const user = await db.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) { console.log(`  ✗ ${email}: no user, skipped`); process.exitCode = 1; continue; }
      const cfg = await db.abTenantConfig.findUnique({ where: { userId: user.id }, select: { accountingBasis: true } });
      const note = cfg?.accountingBasis === 'cash' ? ' (cash basis: stays at_payment regardless)' : cfg ? '' : ' (no tenant config: stays at_payment)';
      if (remove) {
        console.log(`  ${ids.has(user.id) ? '-' : '='} ${email} (${user.id})${ids.has(user.id) ? ' removed' : ' not listed'}`);
        ids.delete(user.id);
      } else {
        console.log(`  ${ids.has(user.id) ? '=' : '+'} ${email} (${user.id})${ids.has(user.id) ? ' already listed' : ' added'}${note}`);
        ids.add(user.id);
      }
    }
  }

  const enabled = global === 'on' ? true : global === 'off' ? false : (row?.enabled ?? false);
  const metadata = { ...meta, tenantIds: [...ids] };
  console.log(`\n  result: enabled=${enabled}, allowlist ${ids.size} tenant(s)`);
  if (!apply) return;
  await db.featureFlag.upsert({
    where: { key: KEY },
    create: { key: KEY, enabled, metadata, description: 'PR 3bc: post AP at bill entry for accrual tenants (global or metadata.tenantIds)' },
    update: { enabled, metadata },
  });
  console.log('  ✓ written');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
