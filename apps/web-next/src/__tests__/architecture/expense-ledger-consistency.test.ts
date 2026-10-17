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
const DETAIL_ROUTE = 'apps/web-next/src/app/api/v1/agentbook-expense/expenses/[id]/route.ts';
const TELEGRAM = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';
const RESTORE_ROUTE = 'apps/web-next/src/app/api/v1/agentbook-core/restore/[entityType]/[id]/route.ts';
const BOT_AGENT = 'apps/web-next/src/lib/agentbook-bot-agent.ts';
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

  it('editing a booked expense (PUT/PATCH) re-posts its journal entry inside the edit transaction', () => {
    const src = read(DETAIL_ROUTE);
    // PUT used to be a bare abExpense.update, so a changed amount or date left
    // P&L and the tax estimate on the old figure.
    const put = src.slice(src.indexOf('export async function PUT'), src.indexOf('export async function PATCH'));
    expect(put).toContain('repostExpenseJournalEntry(');
    expect(put).toContain('db.$transaction');
    expect(read(LEDGER)).toContain("sourceType: 'expense_amend_reversal'");
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

  it("the Telegram 'accept the AI suggestion' button posts the ledger too", () => {
    // Presence of the helper ANYWHERE in the file is not enough — the cat:<code>
    // picker had it and the aiok:<id> accept path did not, so tapping
    // "Yes, book it" moved the category and left the debit on 6999 while the
    // bot replied "booked under <category>".
    const src = read(TELEGRAM);
    const start = src.indexOf("if (action === 'aiok') {");
    expect(start, 'the aiok handler moved or was renamed').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("if (action === 'aichg') {", start));
    expect(block).toContain('backfillExpenseJournalEntry(');
  });
});

describe('restoring, undoing and correcting an expense all go through the shared ledger helpers', () => {
  it('Restore re-books the expense in the same transaction that clears deletedAt', () => {
    const src = read(RESTORE_ROUTE);
    // Restore used to be `updateMany({ deletedAt: null })` and nothing else: the
    // expense reappeared in the list while DELETE's reversal kept it at $0.
    expect(src).toContain('rebookReversedExpenseEntry(');
    const block = src.slice(src.indexOf("entityType === 'expense'"), src.indexOf('clearDeletedAt(entityType'));
    expect(block).toContain('db.$transaction');
    expect(block.indexOf('deletedAt: null')).toBeGreaterThan(-1);
    expect(block.indexOf('deletedAt: null')).toBeLessThan(block.indexOf('rebookReversedExpenseEntry('));
  });

  it("the delete reversal is keyed by the ENTRY being reversed, not by the expense", () => {
    const src = read(LEDGER);
    const fn = src.slice(src.indexOf('export async function reverseExpenseJournalEntry'), src.indexOf('/** Thrown when an edit would rewrite'));
    // Keyed by the expense, a restored-and-re-booked expense collides with its
    // own first delete (P2002 inside the transaction → 500).
    expect(fn).toContain('sourceId: expense.journalEntryId');
    expect(fn).not.toMatch(/sourceId:\s*expenseId/);
  });

  it("the bot's undo and amount fix call the helpers and never hand-write a reversal under ('expense', expenseId)", () => {
    const src = read(BOT_AGENT);
    const from = src.indexOf("case 'expense.undo_last'");
    const to = src.indexOf("await db.abEvent.create", src.indexOf("case 'expense.update_amount'"));
    expect(from).toBeGreaterThan(-1);
    const block = src.slice(from, to);
    expect(block).toContain('unbookExpenseJournalEntry(');
    expect(block).toContain('repostExpenseJournalEntry(');
    // Both used to write a reversal + replacement by hand under one unique key,
    // with no transaction — the replacement then failed and left the expense at $0.
    expect(block).not.toMatch(/abJournalEntry\.create/);
    expect(block).not.toMatch(/sourceType:\s*'expense'/);
  });
});
