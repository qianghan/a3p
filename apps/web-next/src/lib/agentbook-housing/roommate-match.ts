/**
 * Pure roommate compatibility scoring — no I/O, unit-testable.
 *
 * The agent CONSULTS: it ranks other opted-in profiles by compatibility and
 * explains WHY, so the student can decide who to reach out to (through their
 * own school/housing channels). It never messages anyone, and no contact
 * details exist to exchange — compatibility is the whole product here.
 */

export interface RoommateProfileLike {
  tenantId: string;
  jurisdiction: string;
  area: string;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  moveInMonth: string | null;
  lifestyle: string[];
}

export interface MatchReason {
  score: number; // 0..100
  reasons: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Do two [min,max] budget ranges overlap? Open-ended sides count as compatible. */
function budgetsOverlap(a: RoommateProfileLike, b: RoommateProfileLike): boolean {
  const aMin = a.budgetMinCents ?? 0;
  const aMax = a.budgetMaxCents ?? Number.MAX_SAFE_INTEGER;
  const bMin = b.budgetMinCents ?? 0;
  const bMax = b.budgetMaxCents ?? Number.MAX_SAFE_INTEGER;
  return aMin <= bMax && bMin <= aMax;
}

/**
 * Score `other` against `me`. Weights: area match (0/35), budget overlap
 * (0/30), move-in proximity (0/15), shared lifestyle tags (up to 20).
 * Returns null when they're fundamentally incompatible (different area AND no
 * budget overlap) so obviously-irrelevant profiles are dropped, not shown at 0.
 */
export function scoreMatch(me: RoommateProfileLike, other: RoommateProfileLike): MatchReason | null {
  const reasons: string[] = [];
  let score = 0;

  const sameArea = norm(me.area) === norm(other.area) && norm(me.area).length > 0;
  if (sameArea) {
    score += 35;
    reasons.push(`Both looking in ${other.area}`);
  }

  const overlap = budgetsOverlap(me, other);
  if (overlap && (me.budgetMinCents != null || me.budgetMaxCents != null)) {
    score += 30;
    reasons.push('Budgets overlap');
  }

  if (me.moveInMonth && other.moveInMonth) {
    if (me.moveInMonth === other.moveInMonth) {
      score += 15;
      reasons.push(`Same move-in (${other.moveInMonth})`);
    } else {
      // adjacent months still count a little
      score += 5;
    }
  }

  const mine = new Set(me.lifestyle.map(norm));
  const shared = other.lifestyle.filter((t) => mine.has(norm(t)));
  if (shared.length > 0) {
    score += Math.min(20, shared.length * 7);
    reasons.push(`Shared preferences: ${shared.slice(0, 4).join(', ')}`);
  }

  // Fundamentally incompatible: nowhere near each other and no budget overlap.
  if (!sameArea && !overlap) return null;

  return { score: Math.min(100, score), reasons };
}
