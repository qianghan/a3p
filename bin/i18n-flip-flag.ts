/**
 * Turn the i18n translation flag on (or off) for a given database.
 *
 * WHY THIS SCRIPT EXISTS
 *
 * The flag lives in the FeatureFlag table, and the only other ways to set it
 * are the admin UI (needs an authenticated admin session) or a hand-written
 * SQL insert. Neither is reproducible from a terminal, and a hand-written
 * insert is easy to get subtly wrong — the key must match
 * `agentbook.i18n.locales.enabled` exactly or the reader silently returns
 * false and nothing appears to happen.
 *
 * WHAT FLIPPING IT DOES
 *
 *   on   translated strings render for tenants whose locale is fr-CA or zh-CN
 *   off  every tenant reads English strings, whatever their stored locale
 *
 * Date and money FORMATTING is not affected either way — that follows the
 * tenant locale unconditionally, because those were correctness fixes (a bill
 * due date rendered a day early west of UTC) and were deliberately never
 * gated.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not translate anything that has not been extracted yet. Coverage is
 * partial: run `./bin/i18n-string-ratchet.sh` to see how many hardcoded
 * literals remain. Turning this on shows translations on the pages that ARE
 * done and leaves the rest in English.
 *
 * USAGE
 *   DATABASE_URL="postgresql://..." npx tsx bin/i18n-flip-flag.ts --on
 *   DATABASE_URL="postgresql://..." npx tsx bin/i18n-flip-flag.ts --off
 *   DATABASE_URL="postgresql://..." npx tsx bin/i18n-flip-flag.ts --status
 *
 * Prints the resulting state so the outcome is never inferred.
 */

import { PrismaClient } from '@naap/database';

const KEY = 'agentbook.i18n.locales.enabled';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!['--on', '--off', '--status'].includes(arg ?? '')) {
    console.error('usage: i18n-flip-flag.ts --on | --off | --status');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to guess which database to write to.');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    if (arg === '--status') {
      const row = await prisma.featureFlag.findUnique({ where: { key: KEY } });
      if (!row) {
        console.log(`${KEY}: NO ROW -> treated as OFF (the reader is fail-closed)`);
      } else {
        console.log(`${KEY}: ${row.enabled ? 'ON' : 'OFF'} (updated ${row.updatedAt.toISOString()})`);
      }
      return;
    }

    const enabled = arg === '--on';
    const row = await prisma.featureFlag.upsert({
      where: { key: KEY },
      create: {
        key: KEY,
        enabled,
        description:
          'Renders translated UI strings for tenants on fr-CA / zh-CN. Date and money formatting is NOT gated by this.',
      },
      update: { enabled },
    });
    console.log(`${KEY} is now ${row.enabled ? 'ON' : 'OFF'}`);
    if (row.enabled) {
      console.log('');
      console.log('Coverage is partial. Pages already translated show fr-CA / zh-CN;');
      console.log('the rest stay English until their strings are extracted.');
      console.log('Users must reload for the change to take effect.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
