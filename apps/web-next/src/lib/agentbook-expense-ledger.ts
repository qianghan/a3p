/**
 * Expense → ledger posting.
 *
 * An expense only reaches the books via a balanced double-entry journal. The
 * base create posts it inline WHEN a category is known at creation time; but
 * mobile receipt-capture, bank import, and any "categorize later" flow assign
 * the category AFTER creation — and those paths must post the journal then, or
 * the expense is silently absent from P&L, the trial balance, and the tax
 * estimate (understating expenses, overstating profit + tax).
 *
 * This helper is the single, idempotent, best-effort posting path for that
 * back-fill: call it whenever an expense gains a category.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { ensureChartOfAccounts, CASH_CODE } from '@/lib/agentbook-chart-of-accounts';

/**
 * Post the balanced journal (DR category / CR cash) for an expense if it needs
 * one. No-op — returns the existing id or null — when the expense is already
 * booked, is personal, or has no category. Mirrors the create/confirm posting
 * exactly (same lines, same memo/source), so every path produces identical
 * ledger entries.
 */
export async function backfillExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
): Promise<string | null> {
  const expense = await db.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense) return null;
  if (expense.journalEntryId) return expense.journalEntryId; // already on the books
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
