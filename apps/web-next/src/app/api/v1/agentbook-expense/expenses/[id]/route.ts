/**
 * Expense detail + edit.
 *
 * GET — full row + resolved vendor name + category name/code + splits.
 * PUT/PATCH — patch amountCents, categoryId, description, isPersonal, date,
 * vendor (name; '' clears it). An invalid date is a 400 before any write.
 * A new categoryId must be one of the tenant's active expense accounts (400).
 *
 * Ledger (one transaction with the row update, so P&L and the tax estimate
 * always follow the edit):
 *   - amount / date / category of a BOOKED expense → reverse + re-post its entry;
 *   - booked business → personal → reverse it and unlink it;
 *   - confirmed, unbooked personal → business → book it (category or suspense).
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
  unbookExpenseJournalEntry,
  bookExpenseJournalEntry,
  ensureExpenseBookingAccounts,
  ExpenseLedgerPeriodClosedError,
  ExpenseLedgerShapeError,
  ExpenseLedgerAlreadyReversedError,
  ALREADY_REVERSED_MESSAGE,
} from '@/lib/agentbook-expense-ledger';
import { INVALID_CATEGORY_ERROR } from '@/lib/agentbook-categorize-expense';
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
  categoryId?: string | null;
  description?: string;
  isPersonal?: boolean;
  date?: string;
  vendor?: string;
}

/** The row vanished (soft-deleted) between the read and the write. */
class ExpenseGoneError extends Error {}

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
    if (body.isPersonal !== undefined && typeof body.isPersonal !== 'boolean') {
      return NextResponse.json({ success: false, error: 'isPersonal must be a boolean' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (body.amountCents !== undefined) data.amountCents = body.amountCents;

    // A NEW category must be one of this tenant's active expense accounts — the
    // same rule the categorize path enforces — because on a booked expense the
    // ledger debit follows it. An unchanged id is not re-validated, so a form
    // that re-sends the current category keeps working. null / '' clears it.
    if (body.categoryId !== undefined) {
      if (body.categoryId === null || body.categoryId === '') {
        data.categoryId = null;
      } else if (typeof body.categoryId !== 'string') {
        return NextResponse.json(
          { success: false, code: 'invalid_category', error: INVALID_CATEGORY_ERROR },
          { status: 400 },
        );
      } else {
        if (body.categoryId !== existing.categoryId) {
          const category = await db.abAccount.findFirst({
            where: { id: body.categoryId, tenantId, accountType: 'expense', isActive: true },
            select: { id: true },
          });
          if (!category) {
            return NextResponse.json(
              { success: false, code: 'invalid_category', error: INVALID_CATEGORY_ERROR },
              { status: 400 },
            );
          }
        }
        data.categoryId = body.categoryId;
      }
    }
    if (body.description !== undefined) data.description = body.description;
    if (body.isPersonal !== undefined) data.isPersonal = body.isPersonal;
    if (body.date !== undefined) {
      const parsedDate = parseExpenseDate(body.date);
      if (!parsedDate) {
        return NextResponse.json({ success: false, error: 'date must be an ISO date' }, { status: 400 });
      }
      data.date = parsedDate;
    }
    // Validated here; the upsert runs inside the edit transaction so a rejected
    // edit (closed period, split entry, lost race) doesn't leave a vendor behind.
    let vendorUpsert: { name: string; normalizedName: string } | null = null;
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
        vendorUpsert = { name: vendorName, normalizedName: normalized };
      }
    }

    // Booking a personal → business flip, or moving a cleared category to
    // suspense, needs the cash and 6999 accounts. Their seeders run their own
    // upserts, so (as in the create route) they run before the transaction;
    // the ledger helpers then look the accounts up inside it.
    if (
      (body.isPersonal === false && existing.isPersonal) ||
      (data.categoryId === null && existing.categoryId !== null)
    ) {
      await ensureExpenseBookingAccounts(tenantId);
    }

    let updated;
    try {
      updated = await db.$transaction(async (tx) => {
        // Take the row lock FIRST, then read the row as committed by anyone
        // before us, and decide every ledger action from THAT — not from the
        // `existing` snapshot. Concurrent edits (and a DELETE) of this expense
        // serialize on the lock, so two flips can't both book, and an edit
        // can't re-post an entry a DELETE just reversed. Guarded on deletedAt.
        const { count } = await tx.abExpense.updateMany({
          where: { id, tenantId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (count === 0) throw new ExpenseGoneError();
        const prev = await tx.abExpense.findFirst({ where: { id, tenantId } });
        if (!prev) throw new ExpenseGoneError();

        // Upserted inside the transaction so a rejected edit (closed period,
        // split entry, lost race) doesn't leave a vendor behind.
        if (vendorUpsert) {
          const vendorRow = await tx.abVendor.upsert({
            where: { tenantId_normalizedName: { tenantId, normalizedName: vendorUpsert.normalizedName } },
            update: { lastSeen: new Date() },
            create: { tenantId, name: vendorUpsert.name, normalizedName: vendorUpsert.normalizedName },
            select: { id: true },
          });
          data.vendorId = vendorRow.id;
        }
        const row = Object.keys(data).length > 0 ? await tx.abExpense.update({ where: { id }, data }) : prev;

        // Edits that can move money on the books. Description / vendor / an
        // unchanged value never touch the ledger. (A sent date is compared to
        // the entry's own date by the helper.)
        const amountChanged = data.amountCents !== undefined && data.amountCents !== prev.amountCents;
        const categoryChanged = data.categoryId !== undefined && data.categoryId !== prev.categoryId;
        const personalChanged = data.isPersonal !== undefined && data.isPersonal !== prev.isPersonal;
        const touchesLedger = amountChanged || data.date !== undefined || categoryChanged || personalChanged;
        // A rejected expense was already reversed by undo; re-posting would
        // resurrect it.
        if (!touchesLedger || row.status === 'rejected') return row;

        if (row.isPersonal) {
          // Business → personal takes a booked expense off the books. An edit
          // that leaves an already-personal-but-booked expense personal keeps
          // the books matching its amount/date (it was booked by another path).
          if (personalChanged) await unbookExpenseJournalEntry(tenantId, id, tx);
          else if (row.journalEntryId) await repostExpenseJournalEntry(tenantId, id, tx, { categoryChanged });
        } else if (row.journalEntryId) {
          await repostExpenseJournalEntry(tenantId, id, tx, { categoryChanged });
        } else if (personalChanged) {
          // Personal → business on a confirmed, unbooked expense books it.
          await bookExpenseJournalEntry(tenantId, id, tx);
        }
        // An amount/date/category edit of a never-booked row books nothing:
        // pending drafts are booked by confirm / categorize.
        return (await tx.abExpense.findFirst({ where: { id, tenantId } })) ?? row;
      });
    } catch (err) {
      if (err instanceof ExpenseGoneError) {
        return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });
      }
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
      if (err instanceof ExpenseLedgerAlreadyReversedError) {
        // The whole transaction (row, vendor, ledger) rolled back: nothing written.
        return NextResponse.json(
          { success: false, code: 'already_reversed', error: ALREADY_REVERSED_MESSAGE },
          { status: 422 },
        );
      }
      if (err instanceof ExpenseLedgerShapeError) {
        return NextResponse.json(
          {
            success: false,
            error: 'This expense is booked as a split or multi-line entry, so its amount or category cannot be edited automatically',
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
