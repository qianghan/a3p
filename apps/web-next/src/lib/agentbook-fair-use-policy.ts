/**
 * Pure fair-use policy: ceilings and warning thresholds per plan.
 * No imports — safe to unit-test without a database or server context.
 */

export const FAIR_USE_WARN_LEVELS = [0.7, 0.9] as const;

/**
 * Monthly AI-message ceiling per plan code.
 *
 * PLACEHOLDER VALUES — owner must confirm before production. Rationale for
 * the starting points: free/pro match the plan quota templates
 * (apps/web-next/src/lib/billing/templates.ts); business gets a generous
 * but finite ceiling so "unlimited" can't mean unbounded inference cost.
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
