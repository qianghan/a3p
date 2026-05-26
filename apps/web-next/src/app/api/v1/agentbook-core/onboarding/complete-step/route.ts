/**
 * Mark an onboarding step as complete and bump the current-step pointer.
 *
 * PR 46 / Tier 3 #10: emits AbEvent rows on every step completion so the
 * onboarding funnel + first-15-min metric becomes computable from event
 * history alone (no schema-shape assumption — works for both the agent-
 * driven onboarding and the legacy wizard).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ONBOARDING_STEPS_TOTAL = 7;

interface CompleteBody {
  stepId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CompleteBody;
    const { stepId } = body;
    if (!stepId) {
      return NextResponse.json({ success: false, error: 'stepId is required' }, { status: 400 });
    }

    let progress = await db.abOnboardingProgress.findUnique({ where: { tenantId } });
    if (!progress) {
      progress = await db.abOnboardingProgress.create({ data: { tenantId } });
    }

    const wasFirstCompletion = !progress.completedSteps.includes(stepId);
    const completedSteps = [...new Set([...progress.completedSteps, stepId])];
    const currentStep = Math.min(completedSteps.length, 6);
    const justFinished = completedSteps.length === ONBOARDING_STEPS_TOTAL && !progress.completedAt;

    await db.abOnboardingProgress.update({
      where: { tenantId },
      data: {
        completedSteps,
        currentStep,
        ...(stepId === 'bank' && { bankConnected: true }),
        ...(stepId === 'accounts' && { accountsSeeded: true }),
        ...(stepId === 'first_expense' && { firstExpense: true }),
        ...(stepId === 'telegram' && { telegramConnected: true }),
        ...(justFinished && { completedAt: new Date() }),
      },
    });

    // PR 46: telemetry events. Only emit on first completion of a step to
    // avoid double-counting when the UI re-submits. The 'started_at' on
    // the progress row is set at create-time; first_15_min is derivable
    // by comparing 'onboarding.started' and 'onboarding.completed' events.
    if (wasFirstCompletion) {
      try {
        await db.abEvent.create({
          data: {
            tenantId,
            eventType: 'onboarding.step_completed',
            actor: 'user',
            action: {
              stepId,
              stepIndex: completedSteps.indexOf(stepId),
              totalCompleted: completedSteps.length,
              totalSteps: ONBOARDING_STEPS_TOTAL,
              startedAt: progress.createdAt.toISOString(),
              elapsedSecSinceStart: Math.round(
                (Date.now() - progress.createdAt.getTime()) / 1000,
              ),
            },
          },
        });
      } catch {
        /* best-effort telemetry */
      }
    }
    if (justFinished) {
      try {
        const elapsedSec = Math.round(
          (Date.now() - progress.createdAt.getTime()) / 1000,
        );
        await db.abEvent.create({
          data: {
            tenantId,
            eventType: 'onboarding.completed',
            actor: 'user',
            action: {
              totalSteps: ONBOARDING_STEPS_TOTAL,
              completedInSec: elapsedSec,
              under15Min: elapsedSec <= 900,
              completedAt: new Date().toISOString(),
            },
          },
        });
      } catch {
        /* best-effort telemetry */
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[agentbook-core/onboarding/complete-step] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
