/**
 * repair-orphaned-expense-reversals.ts
 *
 * Finds — and, only when told to, repairs — expenses that are LIVE and
 * confirmed but whose journal entry was already reversed, so the user sees them
 * while P&L, the trial balance and the tax estimate count them as $0.
 *
 * Where they came from (both fixed going forward; this cleans up old data):
 *   - POST /agentbook-core/restore/expense/:id used to clear deletedAt without
 *     re-booking, leaving DELETE's reversal standing;
 *   - the Telegram bot's "actually it was $52" fix wrote a reversal and a
 *     replacement under one unique key — the reversal committed, the
 *     replacement failed.
 *
 * REPORT-ONLY BY DEFAULT. With no flags it reads and prints; it writes nothing.
 *
 *   npx tsx --tsconfig apps/web-next/tsconfig.json --conditions=react-server bin/repair-orphaned-expense-reversals.ts
 *   npx tsx --tsconfig apps/web-next/tsconfig.json --conditions=react-server bin/repair-orphaned-expense-reversals.ts --tenant <id>
 *
 * To repair, you must name the database host you intend to write to. The run
 * refuses if it does not match DATABASE_URL — so a stale shell variable cannot
 * silently aim a write at production:
 *
 *   ... --apply --confirm-host <host printed by the report-only run>
 *
 * Repair re-books each `rebookable` row (one transaction per expense) by
 * appending a copy of its entry that cancels the reversal — nothing already
 * posted is edited, apart from re-keying a legacy reversal's source key to the
 * entry it reversed (see rebookReversedExpenseEntry). Rows reported as
 * `needs_review` (the entry was edited after the reversal) are NEVER touched:
 * they need a bookkeeper. Re-running is safe: repaired rows no longer match.
 *
 * `--tsconfig` resolves the app's `@/` imports; `--conditions=react-server` lets
 * its ledger module (marked 'server-only') load outside Next.js.
 */
import { prisma } from '@naap/database';
import {
  findOrphanedExpenseReversals,
  rebookReversedExpenseEntry,
  type OrphanedExpenseReversal,
} from '../apps/web-next/src/lib/agentbook-expense-ledger';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host || '(unknown)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);

function printReport(rows: OrphanedExpenseReversal[]) {
  const rebookable = rows.filter((r) => r.outcome === 'rebookable');
  const review = rows.filter((r) => r.outcome === 'needs_review');
  for (const r of rows) {
    console.log(
      [
        r.outcome.padEnd(12),
        `tenant=${r.tenantId}`,
        `expense=${r.expenseId}`,
        dollars(r.amountCents).padStart(10),
        iso(r.date),
        `reversal=${r.reversalType}${r.legacy ? ' (legacy key)' : ''}`,
        r.description ? JSON.stringify(r.description.slice(0, 40)) : '',
      ].join('  '),
    );
  }
  const sum = (xs: OrphanedExpenseReversal[]) => xs.reduce((s, r) => s + r.amountCents, 0);
  console.log('');
  console.log(`rebookable:   ${rebookable.length} expense(s), ${dollars(sum(rebookable))} missing from the books`);
  console.log(`needs_review: ${review.length} expense(s), ${dollars(sum(review))} — a bookkeeper must look at these; this script will not touch them`);
}

async function main() {
  const tenantId = arg('tenant');
  const apply = flag('apply');
  const host = dbHost();
  console.log(`database host: ${host}${tenantId ? `   tenant filter: ${tenantId}` : '   (all tenants)'}`);
  console.log(apply ? 'mode: APPLY (will write)' : 'mode: report-only (no writes)');
  console.log('');

  if (apply && arg('confirm-host') !== host) {
    console.error(
      `Refusing to write: --apply needs --confirm-host ${host} (it must equal the host of DATABASE_URL, shown above).`,
    );
    process.exitCode = 2;
    return;
  }

  const rows = await findOrphanedExpenseReversals(prisma as never, { tenantId });
  printReport(rows);
  if (!apply) {
    if (rows.some((r) => r.outcome === 'rebookable')) {
      console.log(`\nNothing was changed. To repair the rebookable rows: re-run with --apply --confirm-host ${host}`);
    }
    return;
  }

  let fixed = 0;
  const failed: Array<{ expenseId: string; error: string }> = [];
  for (const r of rows.filter((x) => x.outcome === 'rebookable')) {
    try {
      const res = await prisma.$transaction((tx) => rebookReversedExpenseEntry(r.tenantId, r.expenseId, tx as never));
      if (res.rebooked) fixed++;
      console.log(`  ${r.expenseId}: ${res.outcome}`);
    } catch (err) {
      failed.push({ expenseId: r.expenseId, error: (err as Error).message });
      console.error(`  ${r.expenseId}: FAILED — ${(err as Error).message}`);
    }
  }
  console.log(`\nre-booked ${fixed}; failed ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
