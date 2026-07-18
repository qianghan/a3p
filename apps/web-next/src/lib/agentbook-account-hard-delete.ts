import 'server-only';
import { prisma as db } from '@naap/database';
import { info, warn } from '@/lib/logger';
import { TENANT_DELETE_ORDER } from './agentbook-tenant-data-models';

export interface HardDeleteResult {
  processed: number;
  skippedOwnedTeam: string[];
  deleted: Array<{ tenantId: string; rowsDeleted: number }>;
}

interface DeletionRequestAction {
  scheduledHardDeleteAt?: string;
}

/**
 * Hard-delete every tenant whose 30-day grace period has elapsed.
 *
 * `tenantId` is always `User.id` in this codebase — see
 * agentbook-tenant.ts's own doc comment. A tenant is eligible when its
 * MOST RECENT deletion-lifecycle AbEvent is `account.deletion_requested`
 * (no `account.deletion_cancelled` producer exists anywhere in this
 * codebase today — this mirrors the exact eligibility check already used
 * by GET /api/v1/agentbook/me, which takes the latest of
 * ['account.deletion_requested', 'account.deletion_cancelled'] ordered by
 * createdAt desc and treats `deletionPending` as true only when that
 * latest event is `account.deletion_requested`) and
 * `action.scheduledHardDeleteAt <= now`.
 *
 * Team.owner cascades onDelete — deleting a User who owns a team with
 * OTHER members would delete that team and every other member's rows as
 * a side effect of an unrelated deletion request. Any such tenant is
 * skipped (not deleted) and recorded in `skippedOwnedTeam` for manual
 * follow-up, rather than silently cascading into other users' data. A
 * tenant who owns a team where they are the ONLY member is not at risk of
 * this (no other user's data would be touched) and proceeds normally.
 *
 * Completion is logged via the structured logger only — NOT a new
 * AbEvent row, since re-creating a tenant-scoped record for someone who
 * was just fully deleted would defeat the point of "hard delete."
 */
export async function hardDeleteScheduledAccounts(
  now: Date = new Date(),
  maxTenantsPerRun = 5,
): Promise<HardDeleteResult> {
  const candidateEvents = await db.abEvent.findMany({
    where: { eventType: { in: ['account.deletion_requested', 'account.deletion_cancelled'] } },
    orderBy: { createdAt: 'desc' },
  });

  const latestByTenant = new Map<string, (typeof candidateEvents)[number]>();
  for (const event of candidateEvents) {
    if (!latestByTenant.has(event.tenantId)) latestByTenant.set(event.tenantId, event);
  }

  const eligible: string[] = [];
  for (const [tenantId, event] of latestByTenant) {
    if (event.eventType !== 'account.deletion_requested') continue;
    const action = event.action as DeletionRequestAction | null;
    const scheduledAt = action?.scheduledHardDeleteAt ? new Date(action.scheduledHardDeleteAt) : null;
    if (scheduledAt && scheduledAt.getTime() <= now.getTime()) eligible.push(tenantId);
  }

  const toProcess = eligible.slice(0, maxTenantsPerRun);
  const result: HardDeleteResult = { processed: 0, skippedOwnedTeam: [], deleted: [] };

  for (const tenantId of toProcess) {
    const ownedTeamsWithOthers = await db.team.findMany({
      where: { ownerId: tenantId, members: { some: { userId: { not: tenantId } } } },
      select: { id: true },
    });
    if (ownedTeamsWithOthers.length > 0) {
      warn('account hard-delete skipped: tenant owns a team with other members', {
        source: 'agentbook-account-hard-delete',
        tenantId,
      });
      result.skippedOwnedTeam.push(tenantId);
      result.processed += 1;
      continue;
    }

    let rowsDeleted = 0;
    for (const step of TENANT_DELETE_ORDER) {
      const { count } = await step.deleteMany(tenantId);
      rowsDeleted += count;
    }
    await db.user.delete({ where: { id: tenantId } }).catch(() => {
      // User row may already be gone (e.g. a retried run); the tenant's
      // data is deleted either way, which is the part that matters.
    });

    info('account hard-delete completed', {
      source: 'agentbook-account-hard-delete',
      tenantId,
      rowsDeleted,
    });
    result.deleted.push({ tenantId, rowsDeleted });
    result.processed += 1;
  }

  return result;
}
