/**
 * AI fair-use guardrails (P0-6).
 *
 * The per-message rate limiter (agentbook-rate-limit.ts) stops floods
 * (60/min, 1000/day), but it has no monthly ceiling and no plan awareness —
 * a Business ("unlimited") tenant could burn 30k inference calls a month on
 * a $49 plan. This module adds the missing layer:
 *
 *   - monthly AI-message ceilings per plan code (placeholders — OWNER
 *     DECISION REQUIRED before production; see FAIR_USE_MONTHLY_AI_MESSAGES)
 *   - soft warnings at 70% / 90% via structured `[fair-use]` logs (wire to
 *     the deployment's log-drain alerting for owner notification)
 *   - hard deny at 100% with graceful copy at the call site
 *
 * Storage: AbUserMemory rows keyed `fairuse:ai:<YYYY-MM>`, mirroring the
 * rate limiter's approach (tenant-indexed, no new infra). Counters are
 * fuzzy under concurrency (read-modify-write) — acceptable for a cost
 * guardrail; the per-day rate limiter remains the strict backstop.
 *
 * Failure posture: fail-OPEN with a loud log. A counter-table outage must
 * not brick chat for paying users; the per-day limiter still bounds cost.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import {
  ceilingForPlan,
  warnLevelFor,
  type FairUseWarnLevel,
} from './agentbook-fair-use-policy';

export type { FairUseWarnLevel };
export { ceilingForPlan, warnLevelFor };
export { FAIR_USE_MONTHLY_AI_MESSAGES, FAIR_USE_DEFAULT_CEILING, FAIR_USE_WARN_LEVELS } from './agentbook-fair-use-policy';

function monthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function counterKey(d?: Date): string {
  return `fairuse:ai:${monthKey(d)}`;
}

export interface FairUseCheck {
  allowed: boolean;
  planCode: string;
  monthlyUsed: number;
  monthlyLimit: number;
  warnLevel: FairUseWarnLevel;
  reason?: 'fair_use_monthly_exceeded' | 'fair_use_unavailable';
}

async function readMonthlyCount(tenantId: string): Promise<number> {
  const row = await db.abUserMemory.findUnique({
    where: { tenantId_key: { tenantId, key: counterKey() } },
    select: { value: true },
  });
  if (!row) return 0;
  try {
    const parsed = JSON.parse(row.value) as { count?: number };
    return typeof parsed.count === 'number' ? parsed.count : 0;
  } catch {
    return 0;
  }
}

/**
 * Check the tenant's monthly AI-message budget. Logs structured warnings
 * at 70%/90% and at denial — the owner wires `[fair-use]` log lines to
 * alerting (e.g. Vercel log drains).
 */
export async function checkFairUse(tenantId: string, planCode: string): Promise<FairUseCheck> {
  const monthlyLimit = ceilingForPlan(planCode);
  try {
    const monthlyUsed = await readMonthlyCount(tenantId);
    const warnLevel = warnLevelFor(monthlyUsed, monthlyLimit);
    if (warnLevel > 0) {
      console.warn(
        `[fair-use] tenant=${tenantId} plan=${planCode} ` +
          `at ${Math.round(warnLevel * 100)}% of monthly AI budget ` +
          `(${monthlyUsed}/${monthlyLimit})`,
      );
    }
    const allowed = monthlyUsed < monthlyLimit;
    if (!allowed) {
      console.warn(
        `[fair-use] tenant=${tenantId} plan=${planCode} DENIED at monthly AI budget ` +
          `(${monthlyUsed}/${monthlyLimit})`,
      );
    }
    return {
      allowed,
      planCode,
      monthlyUsed,
      monthlyLimit,
      warnLevel,
      ...(allowed ? {} : { reason: 'fair_use_monthly_exceeded' as const }),
    };
  } catch (err) {
    console.warn('[fair-use] check failed open:', err);
    return {
      allowed: true,
      planCode,
      monthlyUsed: 0,
      monthlyLimit,
      warnLevel: 0,
      reason: 'fair_use_unavailable' as const,
    };
  }
}

/**
 * Record one billable AI message against the tenant's monthly budget.
 * Call after a message is accepted for processing (same semantics as the
 * rate limiter's checkAndIncrement). Best-effort: never throws.
 */
export async function recordFairUseMessage(tenantId: string): Promise<void> {
  try {
    const key = counterKey();
    const row = await db.abUserMemory.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { value: true },
    });
    let count = 0;
    if (row) {
      try {
        count = (JSON.parse(row.value) as { count?: number }).count ?? 0;
      } catch {
        count = 0;
      }
    }
    const value = JSON.stringify({ count: count + 1 });
    await db.abUserMemory.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { value, lastUsed: new Date() },
      // type='fair_use' + confidence=1 marks this as an operational
      // counter so memory-decay logic never "forgets" it mid-month.
      create: { tenantId, key, value, type: 'fair_use', confidence: 1 },
    });
  } catch (err) {
    console.warn('[fair-use] record failed:', err);
  }
}

/** Caller-visible usage snapshot (for the fair-use status route). */
export async function fairUseStatus(tenantId: string, planCode: string) {
  const monthlyLimit = ceilingForPlan(planCode);
  let monthlyUsed = 0;
  try {
    monthlyUsed = await readMonthlyCount(tenantId);
  } catch {
    monthlyUsed = 0;
  }
  return {
    planCode,
    monthlyUsed,
    monthlyLimit,
    warnLevel: warnLevelFor(monthlyUsed, monthlyLimit),
    month: monthKey(),
  };
}
