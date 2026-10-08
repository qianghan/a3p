/**
 * Expense detail + edit.
 *
 * GET — full row + resolved vendor name + category name/code + splits.
 * PUT — patch amountCents, categoryId, description, isPersonal, date. Editing
 *       the amount or date of a BOOKED expense also reverses and re-posts its
 *       journal entry, atomically, so P&L and the tax estimate follow the edit.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';
import {
  reverseExpenseJournalEntry,
  repostExpenseJournalEntry,
  ExpenseLedgerPeriodClosedError,
  ExpenseLedgerShapeError,
} from '@/lib/agentbook-expense-ledger';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const includeDeleted = parseIncludeDeleted(request.nextUrl.searchParams);

    const expense = await db.abExpense.findFirst({
      where: withSoftDelete({ id, tenantId }, includeDeleted),
      include: { vendor: { select: { id: true, name: true } } },
    });
    if (!expense) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    let categoryName: string | null = null;
    let categoryCode: string | null = null;
    if (expense.categoryId) {
      const cat = await db.abAccount.findFirst({ where: { id: expense.categoryId } });
      if (cat) {
        categoryName = cat.name;
        categoryCode = cat.code;
      }
    }

    const splits = await db.abExpenseSplit.findMany({ where: { expenseId: expense.id } });

    return NextResponse.json({
      success: true,
      data: {
        ...expense,
        vendorName: expense.vendor?.name || null,
        categoryName,
        categoryCode,
        splits,
      },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id GET] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

interface UpdateExpenseBody {
  amountCents?: number;
  categoryId?: string;
  description?: string;
  isPersonal?: boolean;
  date?: string;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as UpdateExpenseBody;
    // Soft-delete (PR 26): edits only apply to live rows.
    const existing = await db.abExpense.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    // The ledger columns are Int cents and a Date; reject what can't be posted
    // as a 400 instead of letting Prisma throw a 500 mid-transaction.
    if (
      body.amountCents !== undefined &&
      (typeof body.amountCents !== 'number' || !Number.isInteger(body.amountCents) || body.amountCents <= 0)
    ) {
      return NextResponse.json(
        { success: false, error: 'amountCents must be a positive integer' },
        { status: 400 },
      );
    }
    if (body.date !== undefined && Number.isNaN(new Date(body.date).getTime())) {
      return NextResponse.json({ success: false, error: 'date is not a valid date' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (body.amountCents !== undefined) data.amountCents = body.amountCents;
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.description !== undefined) data.description = body.description;
    if (body.isPersonal !== undefined) data.isPersonal = body.isPersonal;
    if (body.date !== undefined) data.date = new Date(body.date);

    // A booked expense (journal entry exists) whose amount or date moved must
    // have its ledger entry reversed and re-posted in the SAME transaction —
    // otherwise the expense and the books disagree, silently. A rejected
    // expense was already reversed by undo; re-posting would resurrect it.
    const ledgerAffected =
      !!existing.journalEntryId &&
      existing.status !== 'rejected' &&
      ((body.amountCents !== undefined && body.amountCents !== existing.amountCents) ||
        body.date !== undefined);

    let updated;
    try {
      updated = await db.$transaction(async (tx) => {
        const row = await tx.abExpense.update({ where: { id }, data });
        if (!ledgerAffected) return row;
        const { journalEntryId } = await repostExpenseJournalEntry(tenantId, id, tx);
        return journalEntryId ? { ...row, journalEntryId } : row;
      });
    } catch (err) {
      if (err instanceof ExpenseLedgerPeriodClosedError) {
        return NextResponse.json(
          {
            success: false,
            error: 'Period gate violated',
            details: { constraint: 'period_gate', year: err.year, month: err.month, status: 'closed' },
          },
          { status: 422 },
        );
      }
      if (err instanceof ExpenseLedgerShapeError) {
        return NextResponse.json(
          {
            success: false,
            error: 'This expense is booked as a split or multi-line entry, so its amount cannot be edited automatically',
          },
          { status: 422 },
        );
      }
      if ((err as { code?: string })?.code === 'P2002') {
        // Another edit already superseded this journal entry (G-021 unique key).
        return NextResponse.json(
          { success: false, error: 'This expense was just changed by another request; reload and try again' },
          { status: 409 },
        );
      }
      throw err;
    }

    // PR 10 — audit only the fields the caller actually touched.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (body.amountCents !== undefined) {
      before.amountCents = existing.amountCents; after.amountCents = updated.amountCents;
    }
    if (body.categoryId !== undefined) {
      before.categoryId = existing.categoryId; after.categoryId = updated.categoryId;
    }
    if (body.description !== undefined) {
      before.description = existing.description; after.description = updated.description;
    }
    if (body.isPersonal !== undefined) {
      before.isPersonal = existing.isPersonal; after.isPersonal = updated.isPersonal;
    }
    if (body.date !== undefined) {
      before.date = existing.date; after.date = updated.date;
    }
    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'expense.update',
      entityType: 'AbExpense',
      entityId: id,
      before,
      after,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Same shape as PUT — accept both verbs so the new audit-aware web
  // pages (PR 10) can use the more REST-idiomatic verb.
  return PUT(request, ctx);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    // Soft-delete (PR 26): only act on live rows; treat already-deleted as 404
    // so callers can't keep stamping new `deletedAt` values onto the same row.
    const existing = await db.abExpense.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
    }

    // Soft-delete AND reverse the ledger atomically. Without the reversal the
    // expense disappears from the user's list while P&L, the trial balance and
    // the tax estimate keep counting it — a silent divergence between what the
    // user sees and what their books say. Journal entries are immutable, so the
    // correction is a mirror-reversing entry (same approach as invoice void).
    await db.$transaction(async (tx) => {
      await tx.abExpense.update({ where: { id }, data: { deletedAt: new Date() } });
      await reverseExpenseJournalEntry(tenantId, id, tx);
    });

    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'expense.delete',
      entityType: 'AbExpense',
      entityId: id,
      before: {
        amountCents: existing.amountCents,
        vendorId: existing.vendorId,
        categoryId: existing.categoryId,
        date: existing.date,
        description: existing.description,
        isPersonal: existing.isPersonal,
      },
    });

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    console.error('[agentbook-expense/expenses/:id DELETE] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
