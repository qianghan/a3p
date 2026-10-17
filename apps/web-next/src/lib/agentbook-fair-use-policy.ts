/**
 * Pure fair-use policy: ceilings and warning thresholds per plan.
 * No imports — safe to unit-test without a database or server context.
 */

export const FAIR_USE_WARN_LEVELS = [0.7, 0.9] as const;

/**
 * Monthly AI-message ceiling per plan code.
 *
 * APPROVED 2026-10-16 (CRO): free 100 matches the Free plan's 100-message
 * quota; pro 5000/mo (~160/day) is generous for $19 while capping inference
 * cost; business 20000 covers teams. Warnings at 70%/90%, hard deny at 100%.
 * Tune only from real usage data post-launch.
 */
export const FAIR_USE_MONTHLY_AI_MESSAGES: Record<string, number> = {
  free: 100,
  pro: 5000,
  pro_yearly: 5000,
  business: 20000,
  __billing_inactive__: 20000,
};

/** Fallback ceiling for unknown plan codes — conservative, not infinite. */
export const FAIR_USE_DEFAULT_CEILING = 20000;

export type FairUseWarnLevel = 0 | 0.7 | 0.9;

/** Highest warning threshold crossed by used/limit. */
export function warnLevelFor(used: number, limit: number): FairUseWarnLevel {
  if (limit <= 0 || used < 0) return 0;
  const ratio = used / limit;
  if (ratio >= 0.9) return 0.9;
  if (ratio >= 0.7) return 0.7;
  return 0;
}

/** Ceiling lookup with fallback for unknown plan codes. */
export function ceilingForPlan(planCode: string): number {
  return FAIR_USE_MONTHLY_AI_MESSAGES[planCode] ?? FAIR_USE_DEFAULT_CEILING;
}
