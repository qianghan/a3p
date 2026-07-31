/**
 * The e2e seed must clear LEARNED state, or the eval is not reproducible.
 *
 * Three separate bugs this session came from state surviving the reset:
 *
 *   AbPattern      — pointed at accounts the wipe had deleted, and since
 *                    AbJournalLine.accountId has a real FK, recording an
 *                    expense failed outright with a raw Prisma error (#422).
 *   AbUserMemory   — shortcut memories are consulted at STAGE 1 of
 *                    classification, before triggerPatterns are considered, and
 *                    the loop breaks on first match. A shortcut learned in an
 *                    earlier run silently outranks the routing config in this
 *                    one, which is why "and meals?" flipped between runs on
 *                    identical code even after a pattern was added for it.
 *   AbVendor       — learned vendors are what patterns key off.
 *
 * The shape is always the same: the agent learns, the fixture does not forget,
 * and the next run measures a tenant nobody configured. This pins the tables
 * that must be cleared so the omission cannot recur quietly — the failure mode
 * is a wobbling score with no obvious cause, which is expensive to chase.
 *
 * Deliberately NOT asserting a full table list: most tenant-scoped tables are
 * configuration the tenant should keep (AbTaxConfig, AbTelegramBot,
 * AbNotificationPreference). Only state the AGENT writes about the user belongs
 * here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEED = readFileSync(
  // apps/web-next/src/__tests__/api/v1/e2e-test -> repo root is 7 up
  join(__dirname, '../../../../../../../scripts/seed-e2e-user.ts'),
  'utf8',
);

/** State the agent LEARNS about a user. Must not outlive a reset. */
const LEARNED = ['abUserMemory', 'abLearningEvent', 'abConvThread', 'abVendor', 'abPattern'];

describe('seed wipe clears learned state', () => {
  for (const table of LEARNED) {
    it(`clears ${table}`, () => {
      expect(SEED).toMatch(new RegExp(`\\['${table}',`));
    });
  }

  it('deletes vendors AFTER expenses, since AbExpense.vendorId has no cascade', () => {
    const expenses = SEED.indexOf("['abExpense',");
    const vendors = SEED.indexOf("['abVendor',");
    expect(expenses).toBeGreaterThan(-1);
    expect(vendors).toBeGreaterThan(expenses);
  });

  it('deletes patterns BEFORE accounts, since a dangling categoryId breaks the ledger', () => {
    const patterns = SEED.indexOf("['abPattern',");
    const accounts = SEED.indexOf("['abAccount',");
    expect(patterns).toBeGreaterThan(-1);
    expect(accounts).toBeGreaterThan(patterns);
  });

  it('still fails loudly rather than swallowing a failed delete', () => {
    // The whole list is worthless if a delete can fail unnoticed — that cost a
    // full nightly run once already (#413).
    expect(SEED).toMatch(/seed wipe failed at \$\{table\}/);
    expect(SEED).not.toMatch(/deleteMany\([^)]*\)\.catch\(\(\) => \{\}\)/);
  });
});
