/**
 * Bracket-proximity timing advice.
 *
 * Extracted from the money-moves route so the arithmetic is testable. It was
 * inline, and while inline it shipped two defects at once:
 *
 *  1. Its own copy of the bracket tables, already a full tax year stale (2024
 *     US thresholds against the package's 2025 ones).
 *  2. An inverted trigger. It fired when income sat BELOW the ceiling of its own
 *     bracket and advised prepaying "to stay in" a bracket the user could not
 *     leave by spending less — then quoted savings of gap × (nextRate − thisRate),
 *     which is not a real quantity when every dollar involved is already taxed
 *     at thisRate. The dollar figure the agent showed users was invented.
 *
 * Neither was visible to any test, because nothing could call this code without
 * standing up an Express route.
 */
import type { TaxBracket } from '@agentbook/jurisdictions/interfaces';

/** Advice only makes sense within this distance over a threshold. */
export const PROXIMITY_WINDOW_CENTS = 500_000; // $5,000

export interface BracketProximityMove {
  type: 'optimal_timing';
  urgency: 'informational';
  title: string;
  description: string;
  impactCents: number;
}

/**
 * If income has spilled just over a bracket threshold, describe the timing
 * premium of pulling that overage back under it. Returns null when there is no
 * honest advice to give.
 *
 * Above a threshold the rate delta is real: deducting the overage moves that
 * money from the higher band into the lower one, so the premium — the amount
 * gained by deducting NOW rather than next year — is
 * overage × (higherRate − lowerRate).
 *
 * @param incomeCents Income measured the same way the stored estimate measures
 *   it. This is net income, not taxable income, which is a simplification the
 *   feature has always had: it can place a user in a slightly higher band than
 *   their return will. Kept deliberately rather than changed silently, and the
 *   move stays `informational` for that reason.
 */
export function bracketProximityMove(
  incomeCents: number,
  brackets: TaxBracket[],
): BracketProximityMove | null {
  if (incomeCents <= 0) return null;

  for (let i = 1; i < brackets.length; i++) {
    const higher = brackets[i];
    const lower = brackets[i - 1];
    const overage = incomeCents - higher.min;
    if (overage <= 0 || overage >= PROXIMITY_WINDOW_CENTS) continue;

    const savings = Math.round(overage * (higher.rate - lower.rate));
    if (savings <= 0) return null;

    const dollars = (overage / 100).toFixed(0);
    const band = (higher.rate * 100).toFixed(0);
    return {
      type: 'optimal_timing',
      urgency: 'informational',
      title: `$${dollars} over the ${band}% bracket threshold`,
      description:
        `Bringing $${dollars} of deductible spend forward into this tax year would pull that ` +
        `amount back below the ${band}% band, saving roughly $${(savings / 100).toFixed(0)} ` +
        `more than deducting it next year.`,
      impactCents: savings,
    };
  }

  return null;
}
