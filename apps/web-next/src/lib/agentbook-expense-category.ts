/**
 * The one rule for "may this account id be stamped on expense.categoryId?".
 *
 * Every write path that sets an expense's category (categorize, mobile bulk
 * review, PATCH /expenses/:id, POST /expenses) goes through
 * `validateExpenseCategory`, so the rule cannot drift between them.
 *
 * An assignable category is one of THIS tenant's ACTIVE EXPENSE accounts —
 * except the 6999 "Uncategorized Expenses" suspense account. That account is
 * an internal posting target (see UNCATEGORIZED_CODE): an expense with no
 * category debits it, while expense.categoryId stays null. The needs-category
 * and Uncategorized filters, the auto-categorize watchdog and the reports all
 * key off `categoryId === null`, so stamping 6999 on the row would make a
 * still-unclassified expense look classified and drop it from all of them.
 * "Uncategorize" is expressed by clearing the category, never by naming 6999.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { UNCATEGORIZED_CODE } from '@/lib/agentbook-chart-of-accounts';

export const INVALID_CATEGORY_ERROR = 'categoryId is not one of your expense categories';
export const SUSPENSE_CATEGORY_ERROR =
  'Uncategorized Expenses is a system account, not a category; leave the expense uncategorized instead';

/**
 * Foreign, unknown, non-expense and inactive ids share one 400 and one message
 * (it must reveal nothing about other tenants). The suspense account is the
 * caller's own, so it can say what is wrong: 422.
 */
export type CategoryRejection =
  | { status: 400; code: 'invalid_category'; error: typeof INVALID_CATEGORY_ERROR }
  | { status: 422; code: 'invalid_category'; error: typeof SUSPENSE_CATEGORY_ERROR };

export type CategoryCheck = { ok: true } | ({ ok: false } & CategoryRejection);

/** Body of the JSON error response for a rejection (shared by the routes). */
export const categoryRejectionBody = (r: CategoryRejection) => ({ success: false as const, code: r.code, error: r.error });

export async function validateExpenseCategory(tenantId: string, categoryId: string): Promise<CategoryCheck> {
  const account = await db.abAccount.findFirst({
    where: { id: categoryId, tenantId, accountType: 'expense', isActive: true },
    select: { id: true, code: true },
  });
  if (!account) return { ok: false, status: 400, code: 'invalid_category', error: INVALID_CATEGORY_ERROR };
  if (account.code === UNCATEGORIZED_CODE) {
    return { ok: false, status: 422, code: 'invalid_category', error: SUSPENSE_CATEGORY_ERROR };
  }
  return { ok: true };
}
