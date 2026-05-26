/**
 * Onboarding funnel admin endpoint (PR 46 / Tier 3 #10).
 *
 * Aggregates onboarding-related AbEvent rows into a per-step funnel and
 * computes a first-15-minute completion rate. Admin-only — gated by the
 * same `requireAdmin` helper as /admin/llm-configs.
 *
 * Returns:
 *   {
 *     totals: { started, completed, in_progress, abandoned, under15Min },
 *     funnel: [{ stepId, completedCount, dropOffFromPrev }],
 *     medianTimeToCompleteSec: number | null,
 *     samples: { started: N, completed: N, ... }
 *   }
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STEPS_ORDER = [
  'business_type',
  'jurisdiction',
  'currency',
  'accounts',
  'bank',
  'first_expense',
  'telegram',
];

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface StepCompletedAction {
  stepId?: string;
  elapsedSecSinceStart?: number;
}

interface CompletedAction {
  completedInSec?: number;
  under15Min?: boolean;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;

  // Pull all onboarding events. There's no hot path here — the table is
  // small and the admin view is rare. If this becomes a problem we can
  // add a `since` window query parameter.
  const events = await db.abEvent.findMany({
    where: {
      eventType: {
        in: ['onboarding.started', 'onboarding.step_completed', 'onboarding.completed'],
      },
    },
    select: { eventType: true, tenantId: true, action: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const startedTenants = new Set<string>();
  const completedTenants = new Set<string>();
  const under15MinTenants = new Set<string>();
  const stepCompletionsByStep: Record<string, Set<string>> = {};
  const elapsedSecsToFinish: number[] = [];

  for (const ev of events) {
    if (ev.eventType === 'onboarding.started') {
      startedTenants.add(ev.tenantId);
    } else if (ev.eventType === 'onboarding.step_completed') {
      const action = (ev.action as StepCompletedAction | null) ?? {};
      const stepId = action.stepId;
      if (stepId) {
        if (!stepCompletionsByStep[stepId]) stepCompletionsByStep[stepId] = new Set();
        stepCompletionsByStep[stepId].add(ev.tenantId);
      }
    } else if (ev.eventType === 'onboarding.completed') {
      const action = (ev.action as CompletedAction | null) ?? {};
      completedTenants.add(ev.tenantId);
      if (action.under15Min === true) under15MinTenants.add(ev.tenantId);
      if (typeof action.completedInSec === 'number') {
        elapsedSecsToFinish.push(action.completedInSec);
      }
    }
  }

  // Per-step funnel: completedCount + drop-off from previous step. The
  // drop-off for step 0 is computed against `started` rather than the
  // previous step.
  let prevCount = startedTenants.size;
  const funnel = STEPS_ORDER.map((stepId) => {
    const completedCount = stepCompletionsByStep[stepId]?.size ?? 0;
    const dropOffFromPrev = prevCount === 0 ? 0 : Math.max(0, prevCount - completedCount);
    const dropOffPct = prevCount === 0 ? 0 : dropOffFromPrev / prevCount;
    prevCount = completedCount;
    return { stepId, completedCount, dropOffFromPrev, dropOffPct };
  });

  // Abandoned = started but never completed AND last seen >24h ago. Since
  // we don't track last-seen separately here, we treat abandoned as
  // started - completed - in_progress. In-progress = started AND at least
  // one step_completed AND not yet onboarding.completed.
  const inProgressTenants = new Set<string>();
  for (const tid of startedTenants) {
    if (completedTenants.has(tid)) continue;
    const anyStep = STEPS_ORDER.some((s) => stepCompletionsByStep[s]?.has(tid));
    if (anyStep) inProgressTenants.add(tid);
  }
  const abandoned = Math.max(
    0,
    startedTenants.size - completedTenants.size - inProgressTenants.size,
  );

  return NextResponse.json({
    success: true,
    data: {
      totals: {
        started: startedTenants.size,
        completed: completedTenants.size,
        inProgress: inProgressTenants.size,
        abandoned,
        under15Min: under15MinTenants.size,
      },
      under15MinRate:
        completedTenants.size === 0 ? 0 : under15MinTenants.size / completedTenants.size,
      completionRate:
        startedTenants.size === 0 ? 0 : completedTenants.size / startedTenants.size,
      medianTimeToCompleteSec: median(elapsedSecsToFinish),
      funnel,
      samples: {
        started: startedTenants.size,
        completed: completedTenants.size,
      },
    },
  });
}
