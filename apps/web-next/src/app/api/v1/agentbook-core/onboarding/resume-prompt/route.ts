/**
 * GET /api/v1/agentbook-core/onboarding/resume-prompt
 *
 * Tells the frontend whether the current tenant has an unfinished
 * onboarding worth resurfacing — and if so, what the next step label is.
 *
 * Designed for a dashboard-banner consumer that only shows when there's
 * something to show. Returns { shouldShow: false } when the tenant has
 * either never started or already completed onboarding.
 *
 * No DB writes — pure read.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STEP_ORDER = [
  'business_type',
  'jurisdiction',
  'currency',
  'accounts',
  'bank',
  'first_expense',
  'telegram',
];

const STEP_LABELS: Record<string, string> = {
  business_type: 'Choose your business type',
  jurisdiction: 'Set your country & region',
  currency: 'Pick your currency',
  accounts: 'Seed your chart of accounts',
  bank: 'Connect your bank',
  first_expense: 'Log your first expense',
  telegram: 'Connect Telegram',
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const progress = await db.abOnboardingProgress.findUnique({ where: { tenantId } });

  // No row → never started → don't surface a "resume" banner; the standard
  // first-visit experience handles new tenants.
  if (!progress) {
    return NextResponse.json({ success: true, data: { shouldShow: false } });
  }

  // Already done.
  if (progress.completedAt) {
    return NextResponse.json({ success: true, data: { shouldShow: false } });
  }

  // Nothing done yet.
  if (progress.completedSteps.length === 0) {
    return NextResponse.json({ success: true, data: { shouldShow: false } });
  }

  // Find the next step.
  const done = new Set(progress.completedSteps);
  const next = STEP_ORDER.find((s) => !done.has(s));
  if (!next) {
    return NextResponse.json({ success: true, data: { shouldShow: false } });
  }

  const hoursSinceStart = Math.round(
    (Date.now() - progress.createdAt.getTime()) / 3600_000,
  );

  return NextResponse.json({
    success: true,
    data: {
      shouldShow: true,
      completed: progress.completedSteps.length,
      total: STEP_ORDER.length,
      nextStepId: next,
      nextStepLabel: STEP_LABELS[next] || next,
      hoursSinceStart,
      startedAt: progress.createdAt.toISOString(),
    },
  });
}
