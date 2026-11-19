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

function argValues(flag: string, argv: string[] = process.argv): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === flag && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
}

export async function main(argv: string[] = process.argv) {
  const apply = argv.includes('--apply');
  const remove = argv.includes('--remove');
  const global = argValues('--global', argv)[0];
  const emails = argValues('--email', argv).length ? argValues('--email', argv) : PERSONAS;
  console.log(apply ? 'APPLY\n' : 'DRY RUN (pass --apply to write)\n');

  const row = await db.featureFlag.findUnique({ where: { key: KEY } });
  const meta = (row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as { tenantIds?: unknown };
  const before = Array.isArray(meta.tenantIds) ? meta.tenantIds.filter((x): x is string => typeof x === 'string') : [];
  const ids = new Set(before);
  const excludeBefore = Array.isArray((meta as { excludeTenantIds?: unknown }).excludeTenantIds)
    ? ((meta as { excludeTenantIds: unknown[] }).excludeTenantIds).filter((x): x is string => typeof x === 'string') : [];
  const exclude = new Set(excludeBefore);
  console.log(`  flag ${KEY}: ${row ? `enabled=${row.enabled}` : 'no row'}; allowlist ${before.length} tenant(s)`);

  // m1: the legacy control persona is always excluded, so even `--global on` leaves it at_payment.
  for (const email of NEVER_ENABLE) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (u) { exclude.add(u.id); console.log(`  = ${email} (${u.id}) excluded from the flag (legacy control)`); }
    else console.log(`  ! ${email}: no user, cannot exclude`);
  }

  let unresolved = 0;
  if (!global) {
    for (const email of emails) {
      if (!remove && NEVER_ENABLE.includes(email)) {
        console.log(`  ✗ ${email}: the legacy at_payment control (tests/e2e/mobile-app/bills.spec.ts), never enabled — skipped`);
        process.exitCode = 1;
        continue;
      }
      const user = await db.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) { console.log(`  ✗ ${email}: no user`); unresolved++; process.exitCode = 1; continue; }
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

  // m3: any unresolved --email aborts before ANY write, even with --apply.
  if (unresolved > 0) {
    console.log(`\n  ABORT: ${unresolved} email(s) did not resolve; nothing written`);
    process.exitCode = 1;
    return;
  }

  const enabled = global === 'on' ? true : global === 'off' ? false : (row?.enabled ?? false);
  const metadata = { ...meta, tenantIds: [...ids], excludeTenantIds: [...exclude] };
  console.log(`\n  result: enabled=${enabled}, allowlist ${ids.size} tenant(s)`);
  if (!apply) return;
  await db.featureFlag.upsert({
    where: { key: KEY },
    create: { key: KEY, enabled, metadata, description: 'PR 3bc: post AP at bill entry for accrual tenants (global or metadata.tenantIds)' },
    update: { enabled, metadata },
  });
  console.log('  ✓ written');
}

if (process.argv[1] && /enable-purchases-at-entry\.[tj]s$/.test(process.argv[1])) main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
