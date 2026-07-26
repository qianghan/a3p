import 'server-only';
import { prisma } from '@/lib/db';
import { Prisma } from '@naap/database';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { createNotification } from '@/lib/notifications';
import { computeRepMetrics, computeMilestoneProgress, detectAndRecordMilestones } from '@/lib/billing/sales-rep-milestones';
import { decideRepCoaching } from '@/lib/billing/sales-rep-coach-logic';

export { decideRepCoaching } from '@/lib/billing/sales-rep-coach-logic';
export type { CoachInput, CoachDecision, CoachRecommendation } from '@/lib/billing/sales-rep-coach-logic';

/**
 * Autonomous rep-coach (IO). Weekly, per active rep: pick the most relevant
 * moment and send one encouraging message (fully autonomous — messaging only),
 * and queue commission-raise / reward proposals as PENDING recommendations for
 * an admin to approve. Nothing that costs money is applied here. Decision logic
 * is the pure, unit-tested decideRepCoaching; messages are templates (no LLM
 * math), matching the proactive-alerts pattern.
 */

/** Gather a rep's data, run the decision, and perform side effects. */
export async function runRepCoachForTenant(tenantId: string, commissionBps: number): Promise<{ messaged: boolean; recommendationsCreated: number; freshMilestones: string[] }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
  // Detect milestones first (records + one-time congrats; idempotent).
  const fresh = await detectAndRecordMilestones(tenantId).catch(() => [] as { key: string; label: string }[]);
  const [metrics, progress, paidReferralsLast30d, pending] = await Promise.all([
    computeRepMetrics(tenantId),
    computeMilestoneProgress(tenantId),
    prisma.billReferral.count({ where: { referrerTenantId: tenantId, status: 'paid', paidAt: { gte: thirtyDaysAgo } } }),
    prisma.salesRepRecommendation.findMany({ where: { salesRepId: tenantId, status: 'pending' }, select: { type: true } }),
  ]);

  const decision = decideRepCoaching({
    commissionBps,
    metrics,
    next: progress.next,
    paidReferralsLast30d,
    freshMilestones: fresh.map((f) => f.key),
    pendingRecTypes: new Set(pending.map((p) => p.type)),
  });

  let messaged = false;
  if (decision.message) {
    await sendToAllChannels(tenantId, decision.message, { plainText: true }).then(() => { messaged = true; }).catch(() => {});
  }
  let recommendationsCreated = 0;
  for (const rec of decision.recommendations) {
    await prisma.salesRepRecommendation
      .create({ data: { salesRepId: tenantId, type: rec.type, payload: rec.payload as Prisma.InputJsonValue, reason: rec.reason } })
      .then(() => { recommendationsCreated++; })
      .catch((e) => console.error('[rep-coach] create recommendation failed:', e));
  }

  return { messaged, recommendationsCreated, freshMilestones: fresh.map((f) => f.key) };
}

async function adminTenantIds(): Promise<string[]> {
  const role = await prisma.role.findUnique({ where: { name: 'system:admin' }, select: { id: true } });
  if (!role) return [];
  const userRoles = await prisma.userRole.findMany({ where: { roleId: role.id }, select: { userId: true } });
  return userRoles.map((r) => r.userId);
}

/** Weekly entry point: coach every active rep, then send admins a program digest. */
export async function runRepCoach(): Promise<{ repsProcessed: number; messagesSent: number; recommendationsCreated: number }> {
  const reps = await prisma.salesRepProfile.findMany({ where: { status: 'active' }, select: { tenantId: true, commissionBps: true } });
  let messagesSent = 0;
  let recommendationsCreated = 0;
  for (const rep of reps) {
    const r = await runRepCoachForTenant(rep.tenantId, rep.commissionBps).catch(() => null);
    if (r) { if (r.messaged) messagesSent++; recommendationsCreated += r.recommendationsCreated; }
  }

  const [pendingRecs, admins] = await Promise.all([
    prisma.salesRepRecommendation.count({ where: { status: 'pending' } }),
    adminTenantIds(),
  ]);
  if (admins.length > 0) {
    await createNotification({
      category: 'admin_broadcast',
      title: 'Weekly sales-rep program digest',
      body: `${reps.length} active reps coached this week. ${messagesSent} nudged. ${pendingRecs} recommendation${pendingRecs === 1 ? '' : 's'} awaiting your review (commission raises / rewards).`,
      ctaLabel: 'Review reps',
      ctaUrl: '/admin/sales-reps',
      createdByType: 'system',
      audienceType: 'list',
      audienceFilter: { tenantIds: admins },
    }).catch((e) => console.error('[rep-coach] admin digest failed:', e));
  }

  return { repsProcessed: reps.length, messagesSent, recommendationsCreated };
}
