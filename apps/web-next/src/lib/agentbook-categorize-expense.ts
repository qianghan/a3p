/**
 * Categorize / re-categorize an expense + update / create the
 * vendor → category pattern so future expenses auto-categorize.
 *
 * Moved verbatim out of app/api/v1/agentbook-expense/expenses/[id]/categorize
 * so the mobile bulk review (POST /agentbook-core/auto-categorize/review)
 * runs the exact same writes: category, ledger backfill, vendor learning.
 *
 * A human picking a category IS certainty: the expense gets confidence 1.0 and
 * the learned pattern 0.95. A machine caller (the categorize-expenses skill)
 * must send its own `confidence`, because recording a model's guess as user
 * certainty made every auto-applied row indistinguishable from a correction
 * the user actually made — and taught the vendor pattern at 0.95 off it.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { backfillExpenseJournalEntry } from '@/lib/agentbook-expense-ledger';
import { validateExpenseCategory, INVALID_CATEGORY_ERROR, type CategoryRejection } from '@/lib/agentbook-expense-category';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * `source` SELECTS POLICY (whose certainty this is), so it cannot stay an
 * unvalidated free string. Anything not on this list — including a missing
 * source — is treated as a human correction: the strict default, since
 * `auto_categorize` is the one that lets the caller name its own confidence.
 * 'user' (inline row picker) and 'agent_confirmed' (approving a suggested
 * category) are human actions, stored verbatim for provenance.
 */
export const CATEGORIZE_SOURCES = ['auto_categorize', 'user_corrected', 'user', 'agent_confirmed'] as const;
export type CategorizeSource = (typeof CATEGORIZE_SOURCES)[number];
export const normalizeCategorizeSource = (s: unknown): CategorizeSource =>
  (CATEGORIZE_SOURCES as readonly unknown[]).includes(s) ? (s as CategorizeSource) : 'user_corrected';

/**
 * Cap for a pattern learned from an automatic categorization: below the 0.95 a
 * user correction earns, so a human's choice still outranks the machine's.
 */
export const AUTO_PATTERN_CAP = 0.92;

export interface CategorizeInput {
  categoryId?: string;
  source?: unknown;
  /** The caller's own certainty, 0–1. Omitted by the UI, which means 1.0. */
  confidence?: unknown;
}

type UpdatedExpense = Awaited<ReturnType<typeof db.abExpense.update>>;

export { INVALID_CATEGORY_ERROR };

export type CategorizeOutcome =
  | { ok: true; expense: UpdatedExpense }
  | { ok: false; status: 400 | 404; error: string }
  | ({ ok: false } & CategoryRejection);

export async function categorizeExpense(
  tenantId: string,
  expenseId: string,
  input: CategorizeInput,
): Promise<CategorizeOutcome> {
  const { categoryId } = input;
  const source = normalizeCategorizeSource(input.source);
  // Only a machine caller names its own certainty.
  const expenseConfidence =
    source === 'auto_categorize' && typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? clamp01(input.confidence)
      : 1.0;
  const patternConfidence =
    source === 'auto_categorize' ? Math.min(AUTO_PATTERN_CAP, expenseConfidence) : 0.95;

  if (!categoryId) {
    return { ok: false, status: 400, error: 'categoryId is required' };
  }

  // Soft-deleted rows are 404: categorizing one would re-book / reclassify an
  // expense DELETE already took off the books.
  const expense = await db.abExpense.findFirst({ where: { id: expenseId, tenantId, deletedAt: null } });
  if (!expense) {
    return { ok: false, status: 404, error: 'Expense not found' };
  }

  // Never trust the caller's categoryId: only this tenant's ACTIVE EXPENSE
  // accounts — and never the 6999 suspense account — are accepted, before any
  // write. See validateExpenseCategory for why each rejection is shaped as it is.
  const check = await validateExpenseCategory(tenantId, categoryId);
  if (!check.ok) return check;

  const updated = await db.abExpense.update({
    where: { id: expenseId },
    data: { categoryId, confidence: expenseConfidence },
  });

  // Now that the expense has a category, post its ledger entry if it never
  // got one at creation (receipt-capture / bank-import), or move a suspense
  // posting onto the real category.
  await backfillExpenseJournalEntry(tenantId, expenseId);

  // Best-effort: the category + ledger writes above have already committed,
  // so a failure here (e.g. a P2002 on tenantId_vendorPattern when concurrent
  // requests race) must not turn a successful categorization into a 500.
  try {
    if (expense.vendorId) {
      const vendor = await db.abVendor.findUnique({ where: { id: expense.vendorId } });
      if (vendor) {
        await db.abPattern.upsert({
          where: { tenantId_vendorPattern: { tenantId, vendorPattern: vendor.normalizedName } },
          update: {
            categoryId,
            confidence: patternConfidence,
            source,
            usageCount: { increment: 1 },
            lastUsed: new Date(),
          },
          create: {
            tenantId,
            vendorPattern: vendor.normalizedName,
            categoryId,
            confidence: patternConfidence,
            source,
          },
        });
        await db.abVendor.update({
          where: { id: vendor.id },
          data: { defaultCategoryId: categoryId },
        });
      }
    }
  } catch (err) {
    console.warn('[agentbook-expense/expenses/:id/categorize] pattern learning skipped:', err);
  }

  return { ok: true, expense: updated };
}
