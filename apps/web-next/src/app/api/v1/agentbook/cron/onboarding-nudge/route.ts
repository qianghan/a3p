/**
 * Onboarding abandon-recovery cron (PR 53 / Tier 3 #10).
 *
 * Identifies tenants who started onboarding but haven't completed it, and
 * sends a friendly nudge through whichever channel(s) they have configured.
 * The cron is idempotent: each tenant gets at most one nudge per 7 days
 * (gated by an AbEvent stamp), so repeated runs don't spam.
 *
 * Schedule: suggested daily 14:00 UTC (after morning-digest finishes).
 * Bearer-gated when CRON_SECRET is set.
 *
 * Logic:
 *   1. Find AbOnboardingProgress rows where:
 *        - completedAt IS NULL
 *        - createdAt < now - ABANDONED_AFTER_HOURS (default 48h)
 *        - completedSteps.length > 0 (skip never-started — they got no value yet)
 *   2. For each, check the last 'onboarding.abandon_nudge_sent' AbEvent:
 *        - skip if one exists in the last NUDGE_COOLDOWN_DAYS (default 7d)
 *   3. Build a contextual message based on completedSteps:
 *        - "You're 3/7 done — let's finish setting up <next-step>"
 *   4. Send via sendToAllChannels (Telegram + Email + Web AbEvent).
 *   5. Emit 'onboarding.abandon_nudge_sent' AbEvent with the next-step.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ABANDONED_AFTER_HOURS = 48;
const NUDGE_COOLDOWN_DAYS = 7;
const MAX_TENANTS_PER_RUN = 200;

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
  business_type: 'choosing your business type',
  jurisdiction: 'setting your country & region',
  currency: 'picking your currency',
  accounts: 'seeding your chart of accounts',
  bank: 'connecting your bank',
  first_expense: 'logging your first expense',
  telegram: 'connecting Telegram for on-the-go control',
};

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function nextStepFor(completedSteps: string[]): { stepId: string; label: string } | null {
  const done = new Set(completedSteps);
  for (const s of STEP_ORDER) {
    if (!done.has(s)) return { stepId: s, label: STEP_LABELS[s] || s };
  }
  return null;
}

function buildMessage(completed: number, total: number, nextLabel: string): string {
  return (
    `👋 You're ${completed}/${total} done setting up AgentBook — ` +
    `next up: ${nextLabel}.\n\n` +
    `Reply "resume" or open the app to pick up where you left off.`
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(request.headers.get('authorization'), process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const abandonedThreshold = new Date(now.getTime() - ABANDONED_AFTER_HOURS * 3600 * 1000);
    const cooldownThreshold = new Date(now.getTime() - NUDGE_COOLDOWN_DAYS * 24 * 3600 * 1000);

    // Find abandoned onboardings (started >48h ago, no completedAt, ≥1 step done).
    const abandoned = await db.abOnboardingProgress.findMany({
      where: {
        completedAt: null,
        createdAt: { lt: abandonedThreshold },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_TENANTS_PER_RUN,
    });

    let nudged = 0;
    let skippedNoProgress = 0;
    let skippedCooldown = 0;
    let deliveryFailures = 0;

    for (const row of abandoned) {
      if (row.completedSteps.length === 0) {
        skippedNoProgress += 1;
        continue;
      }

      // Cooldown check — has the tenant been nudged in the last NUDGE_COOLDOWN_DAYS?
      const recentNudge = await db.abEvent.findFirst({
        where: {
          tenantId: row.tenantId,
          eventType: 'onboarding.abandon_nudge_sent',
          createdAt: { gte: cooldownThreshold },
        },
        select: { id: true },
      });
      if (recentNudge) {
        skippedCooldown += 1;
        continue;
      }

      const next = nextStepFor(row.completedSteps);
      if (!next) {
        // All steps done but completedAt is null — shouldn't happen (the
        // complete-step endpoint sets completedAt when length === 7), but
        // skip gracefully if it does.
        skippedNoProgress += 1;
        continue;
      }

      const message = buildMessage(row.completedSteps.length, STEP_ORDER.length, next.label);
      const results = await sendToAllChannels(row.tenantId, message, {
        plainText: true,
        subject: 'Finish setting up AgentBook',
      });
      const delivered = results.some((r) => r.delivered);
      if (!delivered) deliveryFailures += 1;

      try {
        await db.abEvent.create({
          data: {
            tenantId: row.tenantId,
            eventType: 'onboarding.abandon_nudge_sent',
            actor: 'system',
            action: {
              completedSteps: row.completedSteps.length,
              totalSteps: STEP_ORDER.length,
              nextStepId: next.stepId,
              channels: results.map((r) => ({ channel: r.channel, delivered: r.delivered })),
              startedAt: row.createdAt.toISOString(),
              hoursSinceStart: Math.round(
                (now.getTime() - row.createdAt.getTime()) / 3600_000,
              ),
            },
          },
        });
      } catch {
        /* best-effort telemetry */
      }

      nudged += 1;
    }

    return NextResponse.json({
      success: true,
      data: {
        candidates: abandoned.length,
        nudged,
        skippedNoProgress,
        skippedCooldown,
        deliveryFailures,
        timestamp: now.toISOString(),
      },
    });
  } catch (err) {
    void reportError('cron/onboarding-nudge failed', err, {
      source: 'cron/onboarding-nudge',
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
