/**
 * Expense → ledger posting.
 *
 * An expense only reaches the books via a balanced double-entry journal. The
 * base create posts every BUSINESS expense inline — against its category when
 * one is known, and against the 6999 suspense account when it isn't, because
 * the cash left the bank either way. (Gating the posting on a resolved category
 * is what made an uncategorized expense silently absent from P&L, the trial
 * balance and the tax estimate while still reading as "confirmed".)
 *
 * Mobile receipt-capture, bank import, and any "categorize later" flow assign
 * the category AFTER creation. This helper is the single, idempotent,
 * best-effort path for that second step: call it whenever an expense gains a
 * category, and it will either post the journal that was never written or move
 * an existing suspense debit onto the real category.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { ensureChartOfAccounts, CASH_CODE, UNCATEGORIZED_CODE } from '@/lib/agentbook-chart-of-accounts';

/**
 * Move an expense's debit off the suspense account onto its real category.
 *
 * Only touches an entry with exactly ONE debit line sitting on 6999 — the shape
 * the create route posts for an uncategorized expense. A split entry, or one
 * already booked to a real category, is left alone.
 *
 * This MUTATES a posted line, against the usual "journal entries are immutable,
 * write a reversing entry instead" rule. That rule doesn't work here: the
 * cash-basis branch of the tax estimate counts expense debits whose entry ALSO
 * credits the cash account (lib/agentbook-tax-estimate.ts). A separate
 * `DR category / CR suspense` reclassification entry credits suspense, not cash,
 * so under cash basis the money would stay attributed to Uncategorized forever
 * while a second, uncounted entry claimed otherwise. Moving the line keeps every
 * report — accrual, cash basis, trial balance, category breakdown — correct with
 * one write, and the entry total never changes, so nothing can unbalance.
 */
async function reclassifyFromSuspense(
  tenantId: string,
  journalEntryId: string,
  categoryId: string,
): Promise<void> {
  const suspense = await db.abAccount.findFirst({ where: { tenantId, code: UNCATEGORIZED_CODE } });
  if (!suspense) return; // tenant never posted to suspense

  const lines = (await db.abJournalLine.findMany({ where: { entryId: journalEntryId } })) || [];
  const debits = lines.filter((l) => l.debitCents > 0);
  if (debits.length !== 1) return; // split or unexpected shape — don't guess
  const debit = debits[0];
  if (debit.accountId !== suspense.id) return; // already on a real category

  await db.abJournalLine.update({
    where: { id: debit.id },
    data: { accountId: categoryId, description: debit.description },
  });
}

/**
 * Post the balanced journal (DR category / CR cash) for an expense if it needs
 * one, or move an existing SUSPENSE posting onto the category it just gained.
 *
 * Returns the existing id or null and posts nothing when the expense is
 * personal or still has no category. Mirrors the create/confirm posting exactly
 * (same lines, same memo/source), so every path produces identical ledger
 * entries.
 */
export async function backfillExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
): Promise<string | null> {
  const expense = await db.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense) return null;
  if (expense.journalEntryId) {
    // Already on the books — but possibly to the SUSPENSE account, because an
    // expense with no category still posts (see UNCATEGORIZED_CODE). Gaining a
    // category means that debit has to move.
    if (expense.categoryId && !expense.isPersonal) {
      await reclassifyFromSuspense(tenantId, expense.journalEntryId, expense.categoryId);
    }
    return expense.journalEntryId;
  }
  if (!expense.categoryId || expense.isPersonal) return null; // nothing bookable

  // Seed the chart of accounts on demand rather than silently skipping. The
  // chart is only created by the onboarding flow, so a tenant who skipped
  // onboarding would otherwise never book anything — their P&L and tax estimate
  // would quietly omit real money.
  let cashAccount = await db.abAccount.findFirst({ where: { tenantId, code: CASH_CODE } });
  if (!cashAccount) {
    await ensureChartOfAccounts(tenantId);
    cashAccount = await db.abAccount.findFirst({ where: { tenantId, code: CASH_CODE } });
  }
  if (!cashAccount) return null; // seeding genuinely failed — don't post a half entry

  const amount = expense.amountCents;
  const desc = expense.description || 'Expense';
  const je = await db.abJournalEntry.create({
    data: {
      tenantId,
      date: expense.date,
      memo: `Expense: ${desc}`,
      sourceType: 'expense',
      sourceId: expense.id,
      verified: true,
      lines: {
        create: [
          { tenantId, accountId: expense.categoryId, debitCents: amount, creditCents: 0, description: desc },
          { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: amount, description: 'Payment' },
        ],
      },
    },
  });
  await db.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: je.id } });
  return je.id;
}

/**
 * Reverse an expense's journal entry when the expense is deleted.
 *
 * Deleting an expense used to stamp `deletedAt` and leave the journal entry in
 * place, so the expense vanished from the user's list while P&L, the trial
 * balance and the tax estimate kept counting it — the mirror image of the
 * "categorized but never booked" bug, and just as silent.
 *
 * Journal entries are immutable by design ("create a reversing entry instead"),
 * so this mirrors the ORIGINAL lines with debit/credit swapped — the same
 * approach invoice void uses. Mirroring is correct for any line shape (2-line
 * untaxed, 3-line with a tax liability, split categories) and needs no
 * knowledge of what the original entry represented.
 *
 * Idempotent: the reversal is written under sourceType 'expense_delete', and
 * @@unique([tenantId, sourceType, sourceId]) makes a second attempt a no-op.
 * Accepts an optional transaction client so callers can reverse and soft-delete
 * atomically.
 */
export async function reverseExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx?: Pick<typeof db, 'abJournalLine' | 'abJournalEntry'>,
): Promise<{ reversed: boolean; reason?: string }> {
  const client = tx ?? db;
  const expense = await db.abExpense.findFirst({
    where: { id: expenseId, tenantId },
    select: { journalEntryId: true, description: true },
  });
  if (!expense?.journalEntryId) return { reversed: false, reason: 'no journal entry to reverse' };

  const originalLines = await client.abJournalLine.findMany({
    where: { entryId: expense.journalEntryId },
  });
  if (originalLines.length === 0) return { reversed: false, reason: 'original entry has no lines' };

  try {
    await client.abJournalEntry.create({
      data: {
        tenantId,
        date: new Date(),
        memo: `DELETED - Reverse expense: ${expense.description || expenseId}`,
        // 'expense_delete', not 'expense' — the original creation entry already
        // holds (tenantId, 'expense', expenseId) and the G-021 unique constraint
        // would reject a second row under that tuple.
        sourceType: 'expense_delete',
        sourceId: expenseId,
        verified: true,
        lines: {
          create: originalLines.map((l) => ({
            tenantId, // G-009
            accountId: l.accountId,
            debitCents: l.creditCents,
            creditCents: l.debitCents,
            description: `Reverse: ${l.description || 'Expense'}`,
          })),
        },
      },
    });
    return { reversed: true };
  } catch (err) {
    // P2002 = the reversal already exists (double delete). Treat as success:
    // the books are already correct, which is all the caller cares about.
    if ((err as { code?: string })?.code === 'P2002') {
      return { reversed: false, reason: 'already reversed' };
    }
    throw err;
  }
}

/** Thrown when an edit would rewrite a month that has been closed. */
export class ExpenseLedgerPeriodClosedError extends Error {
  constructor(public readonly year: number, public readonly month: number) {
    super(`Fiscal period ${year}-${String(month).padStart(2, '0')} is closed`);
    this.name = 'ExpenseLedgerPeriodClosedError';
  }
}

/** Thrown when the booked entry's shape can't be re-priced without guessing. */
export class ExpenseLedgerShapeError extends Error {
  constructor() {
    super('This expense is booked as a split or multi-line entry; its amount cannot be edited automatically');
    this.name = 'ExpenseLedgerShapeError';
  }
}

type RepostClient = Pick<typeof db, 'abExpense' | 'abJournalEntry' | 'abFiscalPeriod'>;

const sameUtcDay = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

async function assertPeriodOpen(client: RepostClient, tenantId: string, date: Date): Promise<void> {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const period = await client.abFiscalPeriod.findUnique({
    where: { tenantId_year_month: { tenantId, year, month } },
  });
  if (period && period.status === 'closed') throw new ExpenseLedgerPeriodClosedError(year, month);
}

/**
 * Bring an expense's ledger entry back in line after its amount or date was
 * edited. Call it INSIDE the transaction that saved the edit, passing the tx.
 *
 * Without this, editing a booked expense changed the row the user sees while
 * P&L, the trial balance and the tax estimate kept the old figure — the third
 * member of the family with "categorized but never booked" (#386) and "deleted
 * but never reversed" (#397).
 *
 * Journal entries are immutable, so this appends two entries rather than
 * touching the original:
 *   1. a mirror reversal of the CURRENT entry, dated at that entry's own date
 *      (so the old month nets to zero — the delete path dates its reversal
 *      "today", which is right for a deletion but would leave an edited
 *      expense counted twice in its original month);
 *   2. a replacement entry at the expense's new amount and date.
 * Both are keyed by the id of the entry being superseded, so
 * @@unique([tenantId, sourceType, sourceId]) (G-021) gives each edit a fresh
 * key (a chain of edits never collides) and rejects two concurrent edits of the
 * same entry — the loser gets P2002 and rolls back rather than double-posting.
 * The replacement debits whatever the original debited, so a category change
 * and a suspense posting behave exactly as they did before.
 *
 * Self-healing and idempotent: it compares the ledger to the expense and does
 * nothing when they already agree.
 */
export async function repostExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx: RepostClient,
): Promise<{ reposted: boolean; journalEntryId: string | null; reason?: string }> {
  const expense = await tx.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense?.journalEntryId) return { reposted: false, journalEntryId: null, reason: 'not booked' };

  const original = await tx.abJournalEntry.findFirst({
    where: { id: expense.journalEntryId, tenantId },
    include: { lines: true },
  });
  if (!original || original.lines.length === 0) {
    return { reposted: false, journalEntryId: expense.journalEntryId, reason: 'original entry has no lines' };
  }

  const originalTotal = original.lines.reduce((s, l) => s + l.debitCents, 0);
  const amountChanged = originalTotal !== expense.amountCents;
  const dateChanged = !sameUtcDay(original.date, expense.date);
  if (!amountChanged && !dateChanged) {
    return { reposted: false, journalEntryId: original.id, reason: 'ledger already matches' };
  }

  let newLines = original.lines.map((l) => ({
    accountId: l.accountId,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    description: l.description,
  }));
  if (amountChanged) {
    // Only the plain DR one-account / CR one-account entry can be re-priced
    // without inventing an allocation. Splits and tax-line entries would need
    // a policy for how the delta is shared; refuse instead of guessing.
    const debits = original.lines.filter((l) => l.debitCents > 0);
    const credits = original.lines.filter((l) => l.creditCents > 0);
    if (original.lines.length !== 2 || debits.length !== 1 || credits.length !== 1) {
      throw new ExpenseLedgerShapeError();
    }
    newLines = newLines.map((l) => ({
      ...l,
      debitCents: l.debitCents > 0 ? expense.amountCents : 0,
      creditCents: l.creditCents > 0 ? expense.amountCents : 0,
    }));
  }

  await assertPeriodOpen(tx, tenantId, original.date);
  if (dateChanged) await assertPeriodOpen(tx, tenantId, expense.date);

  const desc = expense.description || 'Expense';
  await tx.abJournalEntry.create({
    data: {
      tenantId,
      date: original.date,
      memo: `AMENDED - Reverse expense: ${desc}`,
      sourceType: 'expense_amend_reversal',
      sourceId: original.id,
      verified: true,
      lines: {
        create: original.lines.map((l) => ({
          tenantId, // G-009
          accountId: l.accountId,
          debitCents: l.creditCents,
          creditCents: l.debitCents,
          description: `Reverse: ${l.description || 'Expense'}`,
        })),
      },
    },
  });
  const replacement = await tx.abJournalEntry.create({
    data: {
      tenantId,
      date: expense.date,
      memo: `Expense (amended): ${desc}`,
      sourceType: 'expense_amend',
      sourceId: original.id,
      verified: true,
      lines: { create: newLines.map((l) => ({ tenantId, ...l })) }, // G-009
    },
  });
  await tx.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: replacement.id } });
  return { reposted: true, journalEntryId: replacement.id };
}
