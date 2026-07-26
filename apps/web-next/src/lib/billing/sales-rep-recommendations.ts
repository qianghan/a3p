import 'server-only';
import { prisma } from '@/lib/db';
import { updateRepCommission } from '@/lib/billing/sales-rep-admin';
import { createNotification } from '@/lib/notifications';

/**
 * Admin approval queue for the rep-coach's money proposals. Approving a
 * commission_raise applies it via updateRepCommission (PR-3); approving a
 * reward notifies the rep (the actual perk — a comped month, a gift — is
 * granted by the admin out-of-band, this just records + acknowledges it).
 * Dismissing closes it with no effect.
 */

export class RecommendationError extends Error {}

export async function listPendingRecommendations() {
  const recs = await prisma.salesRepRecommendation.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const users = await prisma.user.findMany({
    where: { id: { in: recs.map((r) => r.salesRepId) } },
    select: { id: true, email: true, displayName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return recs.map((r) => ({
    id: r.id,
    salesRepId: r.salesRepId,
    type: r.type,
    payload: r.payload,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    user: { email: byId.get(r.salesRepId)?.email ?? null, displayName: byId.get(r.salesRepId)?.displayName ?? null },
  }));
}

export async function decideRecommendation(
  id: string,
  adminId: string,
  action: 'approve' | 'dismiss',
): Promise<{ id: string; type: string; applied: boolean }> {
  const rec = await prisma.salesRepRecommendation.findUnique({ where: { id } });
  if (!rec) throw new RecommendationError('Recommendation not found.');
  if (rec.status !== 'pending') throw new RecommendationError(`Recommendation already ${rec.status}.`);

  let applied = false;
  if (action === 'approve') {
    if (rec.type === 'commission_raise') {
      const toBps = Number((rec.payload as { toBps?: unknown })?.toBps);
      if (!Number.isInteger(toBps) || toBps <= 0 || toBps > 10000) {
        throw new RecommendationError('Recommendation payload has an invalid toBps.');
      }
      await updateRepCommission(rec.salesRepId, { commissionBps: toBps }); // reuses PR-3 (no plan side-effects)
      applied = true;
      await createNotification({
        category: 'reward',
        title: 'Your commission rate increased 🎉',
        body: `Nice work — your commission rate is now ${(toBps / 100).toFixed(0)}% on new referred revenue.`,
        ctaLabel: 'View dashboard', ctaUrl: '/sales-rep',
        createdByType: 'system', audienceType: 'single', audienceFilter: { tenantId: rec.salesRepId },
      }).catch((e) => console.error('[recommendation] rep notify failed:', e));
    } else if (rec.type === 'reward') {
      applied = true; // acknowledgement only — the perk itself is granted out-of-band by the admin
      await createNotification({
        category: 'reward',
        title: 'A reward is on its way 🎁',
        body: 'Thanks for a standout month as an AgentBook partner — we’re sending a little something your way.',
        createdByType: 'system', audienceType: 'single', audienceFilter: { tenantId: rec.salesRepId },
      }).catch((e) => console.error('[recommendation] rep notify failed:', e));
    }
  }

  await prisma.salesRepRecommendation.update({
    where: { id },
    data: { status: action === 'approve' ? 'approved' : 'dismissed', decidedBy: adminId, decidedAt: new Date() },
  });

  return { id, type: rec.type, applied };
}
