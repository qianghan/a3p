/**
 * Confirm a pending expense — transition status to "confirmed",
 * post a double-entry journal if a category is assigned and the
 * expense is business-only.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { ensureChartOfAccounts } from '@/lib/agentbook-chart-of-accounts';
import { publicErrorMessage } from '@/lib/api-error';
import { bookExpenseJournalEntry } from '@/lib/agentbook-expense-ledger';
import { resolveExpenseTax, isMealsAccount } from '@/lib/expense-tax';
import { TaxCodeError } from '@/lib/tax-codes';
import { assertPeriodOpen, LedgerPeriodClosedError } from '@/lib/ledger-writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ConfirmBody {
  amountCents?: number;
  categoryId?: string;
  description?: string;
  vendorName?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ConfirmBody;

    // A soft-deleted expense is 404, as on every other [id] route: confirming it
    // would book money DELETE already took off the books (e.g. a document
    // deleted on another device while this one still showed it).
    const expense = await db.abExpense.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }
    if (expense.status === 'confirmed') {
      return NextResponse.json({ success: true, data: expense, message: 'Already confirmed' });
    }

    const finalCategoryId = body.categoryId || expense.categoryId;
    const finalAmount = body.amountCents || expense.amountCents;

    const updateData: Record<string, unknown> = { status: 'confirmed' };
    if (body.amountCents) updateData.amountCents = body.amountCents;
    if (body.categoryId) updateData.categoryId = body.categoryId;
    if (body.description) updateData.description = body.description;

    // PR 2b.8 — imported drafts (CSV / CC statement / bank) arrive untyped and
    // unbooked; confirm is where they reach the ledger, so it resolves tax the
    // way every other entry path does: the row's code, else the vendor's
    // default, else the registrant default.
    if (!expense.isPersonal) {
      const [cfg, catAcct, vendor] = await Promise.all([
        db.abTenantConfig.findUnique({
          where: { userId: tenantId },
          select: { jurisdiction: true, region: true, gstRegistered: true, qstRegistered: true },
        }),
        finalCategoryId
          ? db.abAccount.findFirst({ where: { id: finalCategoryId, tenantId }, select: { name: true, taxCategory: true } })
          : null,
        expense.vendorId
          ? db.abVendor.findFirst({ where: { id: expense.vendorId, tenantId }, select: { defaultTaxCode: true } })
          : null,
      ]);
      // Nothing resolves: the row must not carry a split from an old code or
      // amount, or the booking below would post a phantom DR 2100.
      const untype = () => { updateData.taxCode = null; updateData.recoverableTaxCents = 0; };
      const stored = (expense as { taxCode?: string | null }).taxCode ?? undefined;
      try {
        const tax = resolveExpenseTax({
          tenant: cfg,
          taxCode: stored,
          vendorDefaultTaxCode: (vendor as { defaultTaxCode?: string | null } | null)?.defaultTaxCode ?? null,
          amountCents: finalAmount,
          isMeal: isMealsAccount(catAcct),
          printedTaxCents: !stored && expense.taxAmountCents > 0 && !body.amountCents ? expense.taxAmountCents : null,
        });
        if (tax.taxCode) {
          updateData.taxCode = tax.taxCode;
          updateData.taxAmountCents = tax.taxAmountCents;
          updateData.recoverableTaxCents = tax.recoverableTaxCents;
        } else {
          untype();
        }
      } catch (err) {
        if (!(err instanceof TaxCodeError)) throw err;
        untype(); // a stale stored code that no longer applies
      }
    }

    // Seed on demand — the chart is otherwise only created by onboarding, so a
    // tenant who skipped it would silently never book this expense.
    const book = !expense.journalEntryId && !!finalCategoryId && !expense.isPersonal;
    if (book) await ensureChartOfAccounts(tenantId);

    let updated;
    try {
      // Checked before any write as well as inside the booking, so a closed
      // period refuses even where the client cannot roll back.
      if (book) await assertPeriodOpen(db, tenantId, expense.date);
      updated = await db.$transaction(async (tx) => {
        await tx.abExpense.update({ where: { id }, data: updateData });
        // Same tax-aware lines as the create route: DR category (gross − recoverable) | DR 2100 | CR cash.
        if (book) await bookExpenseJournalEntry(tenantId, id, tx);
        return tx.abExpense.findFirst({ where: { id, tenantId } });
      });
    } catch (err) {
      // Same status / body as POST /expenses: the transaction rolled back, so
      // the draft stays pending_review and nothing is booked.
      if (err instanceof LedgerPeriodClosedError) {
        return NextResponse.json(
          { success: false, error: 'Period gate violated', details: { constraint: 'period_gate', year: err.year, month: err.month, status: 'closed' } },
          { status: 422 },
        );
      }
      throw err;
    }

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'expense.confirmed',
        actor: 'user',
        action: { expenseId: id, amountCents: finalAmount },
      },
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id/confirm] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
