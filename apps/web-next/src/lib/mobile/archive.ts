/**
 * Archive / unarchive an expense: a VIEW preference only. Sets or clears
 * AbExpense.archivedAt and nothing else — no journal entry, no total change
 * (archive-ledger-invariant.test.ts proves it). Live rows only; idempotent.
 */
import 'server-only';
import { prisma as db } from '@naap/database';

export type ArchiveOutcome =
  | { ok: true; id: string; archivedAt: Date | null; changed: boolean }
  | { ok: false; status: 404 };

export async function setExpenseArchived(
  tenantId: string,
  id: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<ArchiveOutcome> {
  const existing = await db.abExpense.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: { id: true, archivedAt: true },
  });
  if (!existing) return { ok: false, status: 404 };

  const alreadyThere = archived ? existing.archivedAt !== null : existing.archivedAt === null;
  if (alreadyThere) return { ok: true, id, archivedAt: existing.archivedAt, changed: false };

  // Conditional write: a concurrent archive/unarchive cannot be overwritten.
  // A lost race (count 0) is reported as no change, so the caller writes no audit entry.
  const { count } = await db.abExpense.updateMany({
    where: { id, tenantId, deletedAt: null, archivedAt: archived ? null : { not: null } },
    data: { archivedAt: archived ? now : null },
  });
  const after = await db.abExpense.findFirst({ where: { id, tenantId }, select: { archivedAt: true } });
  return { ok: true, id, archivedAt: after?.archivedAt ?? null, changed: count > 0 };
}
