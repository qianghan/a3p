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
 * credits the cash account (agentbook-tax/tax/estimate/route.ts). A separate
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
