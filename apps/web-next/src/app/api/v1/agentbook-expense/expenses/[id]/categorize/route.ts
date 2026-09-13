/**
 * Categorize / re-categorize an expense + update / create the
 * vendor → category pattern so future expenses auto-categorize.
 *
 * A human picking a category IS certainty: the expense gets confidence 1.0 and
 * the learned pattern 0.95. A machine caller (the categorize-expenses skill)
 * must send its own `confidence`, because recording a model's guess as user
 * certainty made every auto-applied row indistinguishable from a correction
 * the user actually made — and taught the vendor pattern at 0.95 off it.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { backfillExpenseJournalEntry } from '@/lib/agentbook-expense-ledger';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface CategorizeBody {
  categoryId?: string;
  source?: string;
  /** The caller's own certainty, 0–1. Omitted by the UI, which means 1.0. */
  confidence?: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * `source` SELECTS POLICY (whose certainty this is), so it cannot stay an
 * unvalidated free string off the request body. Anything not on this list —
 * including a missing source — is treated as a human correction: the strict
 * default, since `auto_categorize` is the one that lets the caller name its
 * own confidence. The whitelisted value is also what gets persisted to
 * AbPattern.source, so a typo can't create a fifth source kind that later
 * policy has to guess about. The live UI callers send 'user' (inline row
 * picker) and 'agent_confirmed' (approving a suggested category); both are
 * human actions and already take the 1.0 / 0.95 path, and existing rows
 * already carry these two strings verbatim in AbPattern.source — collapsing
 * them into 'user_corrected' would lose that provenance, so they are kept
 * on the whitelist and stored as sent.
 */
const CATEGORIZE_SOURCES = ['auto_categorize', 'user_corrected', 'user', 'agent_confirmed'] as const;
type CategorizeSource = (typeof CATEGORIZE_SOURCES)[number];
const normalizeSource = (s: unknown): CategorizeSource =>
  (CATEGORIZE_SOURCES as readonly unknown[]).includes(s) ? (s as CategorizeSource) : 'user_corrected';

/**
 * Cap for a pattern learned from an automatic categorization. 0.92 is the
 * old inline auto-categorizer's cap: below the 0.95 a user correction earns,
 * so a human's choice still outranks the machine's on the same vendor.
 */
const AUTO_PATTERN_CAP = 0.92;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as CategorizeBody;
    const { categoryId } = body;
    const source = normalizeSource(body.source);
    // Only a machine caller names its own certainty. A user correction IS
    // certainty, so a confidence riding along with any other source is
    // ignored rather than allowed to weaken the row.
    const expenseConfidence =
      source === 'auto_categorize' && typeof body.confidence === 'number' && Number.isFinite(body.confidence)
        ? clamp01(body.confidence)
        : 1.0;
    const patternConfidence =
      source === 'auto_categorize' ? Math.min(AUTO_PATTERN_CAP, expenseConfidence) : 0.95;

    if (!categoryId) {
      return NextResponse.json({ success: false, error: 'categoryId is required' }, { status: 400 });
    }

    const expense = await db.abExpense.findFirst({ where: { id, tenantId } });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    const updated = await db.abExpense.update({
      where: { id },
      data: { categoryId, confidence: expenseConfidence },
    });

    // Now that the expense has a category, post its ledger entry if it never
    // got one at creation (the common case for receipt-capture / bank-import).
    // Without this the categorized expense stays invisible to the books + tax.
    await backfillExpenseJournalEntry(tenantId, id);

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

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/categorize] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
