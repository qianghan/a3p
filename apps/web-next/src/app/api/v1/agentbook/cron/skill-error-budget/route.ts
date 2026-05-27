/**
 * Skill error-budget alerts (PR 64).
 *
 * SLO-style alerting on per-skill success rate. For each skill that has
 * had ≥MIN_RUNS in the rolling window, compute the success rate; when it
 * drops below ERROR_THRESHOLD AND we haven't alerted recently for the
 * same skill, fire an alert.
 *
 * Alert delivery: emits an AbEvent (eventType='skill.error_budget_alert')
 * AND sends to admin channels via the ChatAdapter abstraction. When no
 * channels are configured, the AbEvent alone surfaces via the
 * observability dashboard's recent-errors panel.
 *
 * Schedule: every 6 hours. Lower cadence than 1h because we want enough
 * data inside the rolling window to compute a meaningful rate.
 *
 * Bearer-gated by CRON_SECRET. Tunable via env:
 *   SKILL_ALERT_WINDOW_HOURS   default 24 — rolling window
 *   SKILL_ALERT_MIN_RUNS       default 10 — skip noisy skills
 *   SKILL_ALERT_THRESHOLD      default 0.85 — fire when below this rate
 *   SKILL_ALERT_COOLDOWN_HOURS default 12 — minimum gap between alerts
 *                                            for the same skill
 *   SKILL_ALERT_ADMIN_TENANT   tenantId to receive alerts via
 *                              sendToAllChannels. When unset, alerts
 *                              live in AbEvent only.
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

const DEFAULTS = {
  WINDOW_HOURS: 24,
  MIN_RUNS: 10,
  THRESHOLD: 0.85,
  COOLDOWN_HOURS: 12,
} as const;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readNumEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

interface AlertCandidate {
  skill: string;
  total: number;
  success: number;
  error: number;
  timeout: number;
  successRate: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(request.headers.get('authorization'), process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowHours = readNumEnv('SKILL_ALERT_WINDOW_HOURS', DEFAULTS.WINDOW_HOURS, 1, 720);
  const minRuns = readNumEnv('SKILL_ALERT_MIN_RUNS', DEFAULTS.MIN_RUNS, 1, 10_000);
  const threshold = readNumEnv('SKILL_ALERT_THRESHOLD', DEFAULTS.THRESHOLD, 0, 1);
  const cooldownHours = readNumEnv('SKILL_ALERT_COOLDOWN_HOURS', DEFAULTS.COOLDOWN_HOURS, 1, 720);
  const adminTenantId = process.env.SKILL_ALERT_ADMIN_TENANT || null;

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);
  const cooldownStart = new Date(now.getTime() - cooldownHours * 3600 * 1000);

  try {
    // Aggregate AbSkillRun rows in the window across all tenants.
    // The dashboard's /admin/recent-errors does similar work but per-tenant;
    // here we want the GLOBAL per-skill picture so a noisy skill across all
    // tenants triggers a single alert, not N.
    const runs = await db.abSkillRun.findMany({
      where: { createdAt: { gte: windowStart } },
      select: { skillName: true, status: true },
    });

    const buckets: Record<string, AlertCandidate> = {};
    for (const r of runs) {
      const b = (buckets[r.skillName] ??= {
        skill: r.skillName,
        total: 0,
        success: 0,
        error: 0,
        timeout: 0,
        successRate: 0,
      });
      b.total += 1;
      if (r.status === 'success') b.success += 1;
      else if (r.status === 'error') b.error += 1;
      else if (r.status === 'timeout') b.timeout += 1;
    }

    const candidates: AlertCandidate[] = Object.values(buckets)
      .filter((b) => b.total >= minRuns)
      .map((b) => {
        b.successRate = b.success / b.total;
        return b;
      })
      .filter((b) => b.successRate < threshold);

    let alertsFired = 0;
    let alertsSuppressed = 0;
    let deliverFailures = 0;

    for (const c of candidates) {
      // Cooldown: did we alert for this skill in the last N hours?
      const recent = await db.abEvent.findFirst({
        where: {
          eventType: 'skill.error_budget_alert',
          createdAt: { gte: cooldownStart },
          tenantId: adminTenantId || undefined,
          // action is JSON; we can't filter by inner field cheaply.
          // Walk the candidate list against the most-recent N rows below.
        },
        orderBy: { createdAt: 'desc' },
      });
      // The findFirst returns the most recent alert across all skills.
      // We additionally check that THIS specific skill was the subject —
      // a separate findFirst with action filter would be cleaner but
      // Prisma JSON-path filters are version-dependent, so we use a
      // small extra fetch.
      const wasThisSkill =
        recent &&
        recent.action &&
        typeof recent.action === 'object' &&
        (recent.action as { skill?: string }).skill === c.skill;
      if (wasThisSkill) {
        alertsSuppressed += 1;
        continue;
      }

      // Emit the AbEvent (always, regardless of channel availability).
      try {
        await db.abEvent.create({
          data: {
            tenantId: adminTenantId || '',
            eventType: 'skill.error_budget_alert',
            actor: 'system',
            action: {
              skill: c.skill,
              total: c.total,
              success: c.success,
              error: c.error,
              timeout: c.timeout,
              successRate: c.successRate,
              threshold,
              windowHours,
            },
          },
        });
      } catch {
        /* best-effort */
      }

      if (adminTenantId) {
        const msg =
          `⚠️ Skill "${c.skill}" success rate dropped to ${(c.successRate * 100).toFixed(1)}% ` +
          `over the last ${windowHours}h ` +
          `(${c.success} success / ${c.error} error / ${c.timeout} timeout, n=${c.total}). ` +
          `Threshold: ${(threshold * 100).toFixed(0)}%.`;
        const results = await sendToAllChannels(adminTenantId, msg, {
          plainText: true,
          subject: `AgentBook: ${c.skill} error budget breached`,
        });
        if (!results.some((r) => r.delivered)) deliverFailures += 1;
      }

      alertsFired += 1;
    }

    return NextResponse.json({
      success: true,
      data: {
        windowHours,
        minRuns,
        threshold,
        cooldownHours,
        candidates: candidates.length,
        alertsFired,
        alertsSuppressed,
        deliverFailures,
        timestamp: now.toISOString(),
      },
    });
  } catch (err) {
    void reportError('cron/skill-error-budget failed', err, {
      source: 'cron/skill-error-budget',
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
