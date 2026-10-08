/**
 * Expense detail + edit.
 *
 * GET — full row + resolved vendor name + category name/code + splits.
 * PUT/PATCH — patch amountCents, categoryId, description, isPersonal, date,
 * vendor (name; '' clears it). An invalid date is a 400 before any write.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';
import { reverseExpenseJournalEntry } from '@/lib/agentbook-expense-ledger';
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import { deriveCategorySource, suggestionFromPending } from '@/lib/mobile/doc-mapper';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

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
      const cat = await db.abAccount.findFirst({ where: { id: expense.categoryId, tenantId } });
      if (cat) {
        categoryName = cat.name;
        categoryCode = cat.code;
      }
    }

    const splits = await db.abExpenseSplit.findMany({ where: { expenseId: expense.id } });
    const pending = expense.categoryId ? [] : await getPendingSuggestions(tenantId);

    return NextResponse.json({
      success: true,
      data: {
        ...expense,
        vendorName: expense.vendor?.name || null,
        categoryName,
        categoryCode,
        splits,
        categorySource: deriveCategorySource(expense),
        suggestion: suggestionFromPending(pending.find((p) => p.expenseId === expense.id)),
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
  vendor?: string;
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

    const data: Record<string, unknown> = {};
    if (body.amountCents !== undefined) data.amountCents = body.amountCents;
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.description !== undefined) data.description = body.description;
    if (body.isPersonal !== undefined) data.isPersonal = body.isPersonal;
    if (body.date !== undefined) {
      const parsedDate = typeof body.date === 'string' ? new Date(body.date) : new Date(NaN);
      if (isNaN(parsedDate.getTime())) {
        return NextResponse.json({ success: false, error: 'date must be an ISO date' }, { status: 400 });
      }
      data.date = parsedDate;
    }
    if (body.vendor !== undefined) {
      if (typeof body.vendor !== 'string' || body.vendor.length > 200) {
        return NextResponse.json(
          { success: false, error: 'vendor must be a string of at most 200 characters' },
          { status: 400 },
        );
      }
      const vendorName = body.vendor.trim();
      const normalized = normalizeVendorName(vendorName);
      if (!normalized) {
        data.vendorId = null;
      } else {
        const vendorRow = await db.abVendor.upsert({
          where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } },
          update: { lastSeen: new Date() },
          create: { tenantId, name: vendorName, normalizedName: normalized },
          select: { id: true },
        });
        data.vendorId = vendorRow.id;
      }
    }

    const updated = await db.abExpense.update({ where: { id }, data });
    const linkedVendor = updated.vendorId
      ? await db.abVendor.findFirst({ where: { id: updated.vendorId, tenantId }, select: { name: true } })
      : null;

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
    if (body.vendor !== undefined) {
      before.vendorId = existing.vendorId; after.vendorId = updated.vendorId;
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

    return NextResponse.json({ success: true, data: { ...updated, vendorName: linkedVendor?.name ?? null } });
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
