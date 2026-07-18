import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma as db } from '@naap/database';

vi.mock('server-only', () => ({}));

import { hardDeleteScheduledAccounts } from '../agentbook-account-hard-delete';

// This test requires an isolated Postgres instance reachable via
// DATABASE_URL — run against a throwaway container, never the shared
// local dev DB or production. AbExpense has no `category` field (the
// optional column is `categoryId`) — verified against the current
// packages/database/prisma/schema.prisma.

describe('hardDeleteScheduledAccounts', () => {
  it('deletes a tenant whose grace period has elapsed, including the User row', async () => {
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
    const requestedAt = new Date('2026-01-01T00:00:00Z');
    const scheduledHardDeleteAt = new Date('2026-01-31T00:00:00Z');
    await db.abEvent.create({
      data: {
        tenantId: userId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: {
          requestedAt: requestedAt.toISOString(),
          scheduledHardDeleteAt: scheduledHardDeleteAt.toISOString(),
          gracePeriodDays: 30,
        },
      },
    });
    await db.abExpense.create({
      data: { tenantId: userId, amountCents: 100, categoryId: 'test-category', date: new Date(), description: 'x' },
    });

    const now = new Date('2026-02-01T00:00:00Z'); // past scheduledHardDeleteAt
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.deleted.some((d) => d.tenantId === userId)).toBe(true);
    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await db.abExpense.count({ where: { tenantId: userId } })).toBe(0);
    expect(await db.abEvent.count({ where: { tenantId: userId } })).toBe(0);
  });

  it('does NOT touch a tenant whose grace period has not yet elapsed', async () => {
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
    await db.abEvent.create({
      data: {
        tenantId: userId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { scheduledHardDeleteAt: new Date('2026-06-01T00:00:00Z').toISOString() },
      },
    });

    const now = new Date('2026-02-01T00:00:00Z'); // before scheduledHardDeleteAt
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.deleted.some((d) => d.tenantId === userId)).toBe(false);
    expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('skips (does not delete the User row) when the tenant owns a team with other members, and records it', async () => {
    const ownerId = randomUUID();
    const otherMemberId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local` } });
    await db.user.create({ data: { id: otherMemberId, email: `${otherMemberId}@test.local` } });
    const team = await db.team.create({ data: { name: 'Shared Team', slug: `team-${ownerId.slice(0, 8)}`, ownerId } });
    await db.teamMember.create({ data: { teamId: team.id, userId: otherMemberId, role: 'member' } });
    await db.abEvent.create({
      data: {
        tenantId: ownerId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { scheduledHardDeleteAt: new Date('2026-01-01T00:00:00Z').toISOString() },
      },
    });

    const now = new Date('2026-02-01T00:00:00Z');
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.skippedOwnedTeam).toContain(ownerId);
    expect(await db.user.findUnique({ where: { id: ownerId } })).not.toBeNull();
    expect(await db.team.findUnique({ where: { id: team.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: otherMemberId } })).not.toBeNull();
  });

  it('does NOT skip a tenant who owns a team where they are the only member', async () => {
    const ownerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local` } });
    const team = await db.team.create({ data: { name: 'Solo Team', slug: `team-solo-${ownerId.slice(0, 8)}`, ownerId } });
    await db.abEvent.create({
      data: {
        tenantId: ownerId,
        eventType: 'account.deletion_requested',
        actor: 'user',
        action: { scheduledHardDeleteAt: new Date('2026-01-01T00:00:00Z').toISOString() },
      },
    });

    const now = new Date('2026-02-01T00:00:00Z');
    const result = await hardDeleteScheduledAccounts(now);

    expect(result.skippedOwnedTeam).not.toContain(ownerId);
    expect(result.deleted.some((d) => d.tenantId === ownerId)).toBe(true);
    expect(await db.user.findUnique({ where: { id: ownerId } })).toBeNull();
    // Team.owner cascades onDelete: Cascade — the solo team is expected to
    // go away with its only-member owner, which is correct (no other
    // user's data is affected).
    expect(await db.team.findUnique({ where: { id: team.id } })).toBeNull();
  });

  it('respects maxTenantsPerRun and only processes that many eligible tenants', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      await db.user.create({ data: { id, email: `${id}@test.local` } });
      await db.abEvent.create({
        data: {
          tenantId: id,
          eventType: 'account.deletion_requested',
          actor: 'user',
          action: { scheduledHardDeleteAt: new Date('2026-01-01T00:00:00Z').toISOString() },
        },
      });
    }
    const result = await hardDeleteScheduledAccounts(new Date('2026-02-01T00:00:00Z'), 2);
    expect(result.processed).toBe(2);
  });
});
