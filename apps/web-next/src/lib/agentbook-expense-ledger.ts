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
