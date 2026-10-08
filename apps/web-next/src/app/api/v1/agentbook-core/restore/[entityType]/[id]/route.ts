/**
 * Soft-delete restoration endpoint (PR 26).
 *
 * POST /api/v1/agentbook-core/restore/:entityType/:id
 *
 *   entityType ∈ {expense, invoice, client, vendor, budget, mileage}
 *
 * Sets `deletedAt = null` on the row when:
 *   1. it exists in the caller's tenant,
 *   2. it is currently soft-deleted (deletedAt IS NOT NULL),
 *   3. the soft-delete is within the 90-day restore window.
 *
 * An EXPENSE is also put back on the books: DELETE posts a mirror reversal of
 * its journal entry, so clearing deletedAt alone left a restored expense in the
 * list while the ledger (P&L, trial balance, tax estimate) still netted it to
 * $0. The row update and the re-booking commit together; the response says
 * which happened in `data.ledger`:
 *   rebooked | not_booked | already_on_books | needs_review
 * (needs_review: the entry was edited after the delete, so a bookkeeper must
 * decide — the row is restored, the books are not touched.)
 *
 * Returns:
 *   200 — restored
 *   404 — entity not found / wrong tenant / not deleted
 *   409 — the books can't take the re-booking right now (month closed, or a
 *         concurrent change); nothing was changed
 *   422 — past the 90-day window (housekeeping cron will purge)
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { canRestore, RESTORE_WINDOW_DAYS } from '@/lib/agentbook-soft-delete';
import { publicErrorMessage } from '@/lib/api-error';
import { ExpenseLedgerPeriodClosedError, rebookReversedExpenseEntry } from '@/lib/agentbook-expense-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type EntityType = 'expense' | 'invoice' | 'client' | 'vendor' | 'budget' | 'mileage';

const ENTITIES: Record<EntityType, { auditType: string }> = {
  expense: { auditType: 'AbExpense' },
  invoice: { auditType: 'AbInvoice' },
  client: { auditType: 'AbClient' },
  vendor: { auditType: 'AbVendor' },
  budget: { auditType: 'AbBudget' },
  mileage: { auditType: 'AbMileageEntry' },
};

function isEntityType(s: string): s is EntityType {
  return Object.prototype.hasOwnProperty.call(ENTITIES, s);
}

/**
 * Lookup-then-clear-deletedAt against the right table. Centralised so
 * the route handler stays small and we don't duplicate the same
 * findFirst/update pair six times.
 */
async function findDeleted(
  entityType: EntityType,
  id: string,
  tenantId: string,
): Promise<{ deletedAt: Date | null } | null> {
  const where = { id, tenantId };
  switch (entityType) {
    case 'expense':
      return db.abExpense.findFirst({ where, select: { deletedAt: true } });
    case 'invoice':
      return db.abInvoice.findFirst({ where, select: { deletedAt: true } });
    case 'client':
      return db.abClient.findFirst({ where, select: { deletedAt: true } });
    case 'vendor':
      return db.abVendor.findFirst({ where, select: { deletedAt: true } });
    case 'budget':
      return db.abBudget.findFirst({ where, select: { deletedAt: true } });
    case 'mileage':
      return db.abMileageEntry.findFirst({ where, select: { deletedAt: true } });
  }
}

async function clearDeletedAt(
  entityType: EntityType,
  id: string,
  tenantId: string,
): Promise<void> {
  // Use updateMany so the tenant scope is enforced server-side — a
  // mismatched tenant returns count=0 instead of throwing on missing row.
  switch (entityType) {
    case 'expense':
      await db.abExpense.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
    case 'invoice':
      await db.abInvoice.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
    case 'client':
      await db.abClient.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
    case 'vendor':
      await db.abVendor.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
    case 'budget':
      await db.abBudget.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
    case 'mileage':
      await db.abMileageEntry.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
      return;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { entityType, id } = await params;

    if (!isEntityType(entityType)) {
      return NextResponse.json(
        {
          success: false,
          error: `unknown entityType '${entityType}' — must be one of: ${Object.keys(ENTITIES).join(', ')}`,
        },
        { status: 400 },
      );
    }

    const row = await findDeleted(entityType, id, tenantId);
    if (!row) {
      return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
    }
    if (row.deletedAt === null) {
      return NextResponse.json(
        { success: false, error: 'row is not deleted; nothing to restore' },
        { status: 404 },
      );
    }

    const now = new Date();
    if (!canRestore(row.deletedAt, now)) {
      return NextResponse.json(
        {
          success: false,
          error: `restore window expired — soft-deleted ${RESTORE_WINDOW_DAYS}d ago or earlier`,
          deletedAt: row.deletedAt,
          windowDays: RESTORE_WINDOW_DAYS,
        },
        { status: 422 },
      );
    }

    let ledger: string | undefined;
    if (entityType === 'expense') {
      try {
        // Clear deletedAt and re-book in ONE transaction: a restored expense
        // is never visible without its books, nor booked while still deleted.
        ledger = await db.$transaction(async (tx) => {
          await tx.abExpense.updateMany({ where: { id, tenantId }, data: { deletedAt: null } });
          return (await rebookReversedExpenseEntry(tenantId, id, tx)).outcome;
        });
      } catch (err) {
        if (err instanceof ExpenseLedgerPeriodClosedError) {
          return NextResponse.json(
            {
              success: false,
              error: `Can't restore this expense: its books can only be re-posted into an open period, and ${err.year}-${String(err.month).padStart(2, '0')} is closed`,
              details: { constraint: 'period_gate', year: err.year, month: err.month, status: 'closed' },
            },
            { status: 409 },
          );
        }
        if ((err as { code?: string })?.code === 'P2002') {
          return NextResponse.json(
            { success: false, error: 'This expense was just changed by another request; reload and try again' },
            { status: 409 },
          );
        }
        throw err;
      }
    } else {
      await clearDeletedAt(entityType, id, tenantId);
    }

    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: `${entityType}.restore`,
      entityType: ENTITIES[entityType].auditType,
      entityId: id,
      before: { deletedAt: row.deletedAt },
      after: ledger ? { deletedAt: null, ledger } : { deletedAt: null },
    });

    return NextResponse.json({ success: true, data: { id, entityType, ...(ledger ? { ledger } : {}) } });
  } catch (err) {
    console.error('[agentbook-core/restore POST] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
