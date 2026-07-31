/**
 * Architectural invariants for expense → ledger posting.
 *
 * Structural, deliberately not arithmetic. The recurring failure in this area
 * is never bad maths — it is a surface that keeps its OWN copy of the posting
 * logic and drifts from the shared helpers:
 *
 *  #395/#396  chart seeding was gated on a resolved category, so the tenants
 *             with no chart never got one.
 *  #386       categorizing an expense didn't post its journal entry.
 *  #397       deleting an expense didn't reverse it.
 *  (this PR)  an expense with no category posted NOTHING, so it was absent
 *             from P&L, the trial balance and the tax estimate while showing
 *             as "confirmed" — and absent from the review queue too.
 *
 * The Telegram webhook is the usual offender: it duplicates the categorize and
 * confirm flows inline instead of calling agentbook-expense-ledger. A unit test
 * of the helper can't see that, because the helper is fine — it just isn't
 * called. So assert the wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// apps/web-next/src/__tests__/architecture -> repo root
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LEDGER = 'apps/web-next/src/lib/agentbook-expense-ledger.ts';
const CHART = 'apps/web-next/src/lib/agentbook-chart-of-accounts.ts';
const CREATE_ROUTE = 'apps/web-next/src/app/api/v1/agentbook-expense/expenses/route.ts';
const TELEGRAM = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';
const PACKS = ['us', 'ca', 'au'].map(
  (j) => `packages/agentbook-jurisdictions/src/${j}/chart-of-accounts.ts`,
);

describe('every business expense reaches the books', () => {
  it('the shared ledger helper and chart module exist', () => {
    expect(existsSync(join(ROOT, LEDGER))).toBe(true);
    expect(existsSync(join(ROOT, CHART))).toBe(true);
  });

  it('the create route does NOT gate its journal posting on a resolved category', () => {
    const src = read(CREATE_ROUTE);
    // The exact shape of the bug: `if (resolvedCategoryId && !isPersonal)`
    // around the journal-entry create. An uncategorized expense must still
    // post — to the suspense account — because the cash left the bank.
    expect(src).not.toMatch(/if\s*\(\s*resolvedCategoryId\s*&&\s*!isPersonal\s*\)/);
    expect(src).toContain('ensureUncategorizedAccount');
  });

  it('every jurisdiction chart pack defines the suspense account', () => {
    for (const pack of PACKS) {
      expect(read(pack), `${pack} is missing the 6999 suspense account`).toContain("code: '6999'");
    }
  });

  it('the Telegram categorize handler calls the shared ledger helper', () => {
    const src = read(TELEGRAM);
    // Telegram sets categoryId inline. Without this call the expense's debit
    // stays on the suspense account after the user picked a real category, so
    // the category breakdown and every Schedule C / T2125 / BAS line stay wrong.
    expect(src).toContain('backfillExpenseJournalEntry');
  });
});
