/**
 * Structural guard for the Telegram webhook's category writers.
 *
 * The webhook handles callbacks inside one 6000-line closure that no harness
 * can drive, and it duplicates the categorize flow inline (the usual drift
 * source: see expense-ledger-consistency.test.ts). So assert the wiring: every
 * category picker is drawn from the shared list filter, and both handlers that
 * stamp a category validate it with the shared rule first. The behaviour of the
 * rule itself is covered in lib/agentbook-expense-category + the HTTP routes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const src = readFileSync(
  join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'),
  'utf8',
);

/** The source of one `if (action === '<name>')` callback branch. */
const branch = (name: string): string => {
  const start = src.indexOf(`if (action === '${name}')`);
  expect(start, `callback branch ${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\n      if (action === ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
};

describe('Telegram category writers never reach the 6999 suspense account', () => {
  it('no picker / bot-context category list is queried with the raw expense-account filter', () => {
    // Raw `{ tenantId, accountType: 'expense', isActive: true }` includes 6999.
    // Lists that SHOW categories select their `name`; the one remaining raw
    // query only collects ids to total spend, where 6999 must still count.
    const rawListQueries = src.match(
      /abAccount\.findMany\(\{\s*where:\s*\{\s*tenantId,\s*accountType:\s*'expense',\s*isActive:\s*true\s*\},[^)]{0,120}name:\s*true/g,
    );
    expect(rawListQueries).toBeNull();
    expect(src.match(/where:\s*assignableCategoryWhere\(tenantId\)/g)?.length).toBe(4);
  });

  it.each(['cat', 'aiok'])('the %s handler validates the category before it writes the expense', (name) => {
    const b = branch(name);
    const check = b.indexOf('validateExpenseCategory(');
    const write = b.indexOf('db.abExpense.update(');
    expect(check, `${name}: no validateExpenseCategory call`).toBeGreaterThan(-1);
    expect(write, `${name}: no expense update found`).toBeGreaterThan(-1);
    expect(check).toBeLessThan(write);
  });
});
