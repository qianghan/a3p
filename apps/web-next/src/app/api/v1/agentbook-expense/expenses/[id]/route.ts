/**
 * Expense detail + edit.
 *
 * GET — full row + resolved vendor name + category name/code + splits.
 * PUT/PATCH — patch amountCents, categoryId, description, isPersonal, date,
 * vendor (name; '' clears it). An invalid date is a 400 before any write.
 * Editing the amount or date of a BOOKED expense also reverses and re-posts its
 * journal entry, atomically, so P&L and the tax estimate follow the edit.
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
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import { deriveCategorySource, suggestionFromPending } from '@/lib/mobile/doc-mapper';
import { publicErrorMessage } from '@/lib/api-error';
import { isIsoCalendarDate } from '@/lib/iso-calendar-date';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Upsert key for a vendor name the ASCII normalizer reduces to '' (e.g. '星巴克',
 * Cyrillic, Arabic). Without it those names would take the "clear vendor"
 * branch and silently drop the existing link. Only names with no ASCII letter
 * or digit reach this key. The one overlap with ASCII keys is NFKC folding
 * (full-width '１２３' → '123'), which links to the same vendor as '123', as intended.
 */
function unicodeVendorKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** YYYY-MM-DD, optionally followed by a time part. Rejects '1', 'June 1', etc. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/**
 * A date-only string must be a real calendar day ('2026-02-30' is a 400, not
 * 2 March); a full ISO timestamp keeps the prefix check + Date parse.
 */
function parseExpenseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !ISO_DATE_PREFIX.test(v)) return null;
  if (!v.includes('T') && !isIsoCalendarDate(v)) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
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
    // The suggestion is decoration: its failure must never 500 the detail view.
    const pending = expense.categoryId
      ? []
      : await getPendingSuggestions(tenantId).catch((err) => {
          console.warn('[agentbook-expense/expenses/:id GET] pending suggestions unavailable:', err instanceof Error ? err.message : err);
          return [];
        });

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

    const data: Record<string, unknown> = {};
    if (body.amountCents !== undefined) data.amountCents = body.amountCents;
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.description !== undefined) data.description = body.description;
    if (body.isPersonal !== undefined) data.isPersonal = body.isPersonal;
    if (body.date !== undefined) {
      const parsedDate = parseExpenseDate(body.date);
      if (!parsedDate) {
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
      // Only an empty (or whitespace-only) name clears the vendor.
      const normalized = vendorName ? normalizeVendorName(vendorName) || unicodeVendorKey(vendorName) : '';
      if (!vendorName) {
        data.vendorId = null;
      } else if (!normalized) {
        return NextResponse.json(
          { success: false, error: 'vendor must contain at least one letter or digit' },
          { status: 400 },
        );
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
