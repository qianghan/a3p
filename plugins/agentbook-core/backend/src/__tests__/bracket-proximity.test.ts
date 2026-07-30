/**
 * Guards on bracket-proximity timing advice.
 *
 * This is money advice the agent volunteers, with a specific dollar figure
 * attached, so it needs to be right for the reason it claims. Two shipped
 * defects motivate these cases:
 *
 *   - the trigger was inverted (fired BELOW a ceiling, where the advice is
 *     incoherent and the quoted saving does not exist), and
 *   - the bracket table was a local copy that had drifted a full tax year.
 *
 * Both were invisible because the logic lived inside an Express route.
 */
import { describe, it, expect } from 'vitest';
import { bracketProximityMove, PROXIMITY_WINDOW_CENTS } from '../bracket-proximity.js';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import type { TaxBracket } from '@agentbook/jurisdictions/interfaces';

// Simple two-band table: 10% up to $10,000, then 22%.
const BANDS: TaxBracket[] = [
  { min: 0, max: 1_000_000, rate: 0.1 },
  { min: 1_000_000, max: null as unknown as number, rate: 0.22 },
];

describe('bracketProximityMove', () => {
  it('fires just OVER a threshold and prices the rate delta, not the whole deduction', () => {
    // $1,000 over the $10,000 threshold. Moving it below saves the 12-point
    // spread on that $1,000 = $120. (Deducting it is worth more than that in
    // total; $120 is the premium for doing it THIS year rather than next.)
    const move = bracketProximityMove(1_100_000, BANDS);
    expect(move).not.toBeNull();
    expect(move!.impactCents).toBe(120_00);
    expect(move!.title).toContain('22%');
    expect(move!.urgency).toBe('informational');
  });

  it('stays silent BELOW a bracket ceiling — the inverted trigger that shipped', () => {
    // $9,000: inside the 10% band, $1,000 short of the ceiling. The old code
    // fired here and told the user to prepay $1,000 "to stay in the 10% bracket
    // and save ~$120". They could not leave that bracket by spending less, and
    // the $120 was not a real quantity. There is no advice to give.
    expect(bracketProximityMove(900_000, BANDS)).toBeNull();
  });

  it('stays silent when the overage is beyond the advice window', () => {
    expect(bracketProximityMove(1_000_000 + PROXIMITY_WINDOW_CENTS, BANDS)).toBeNull();
    expect(bracketProximityMove(1_000_000 + PROXIMITY_WINDOW_CENTS + 1, BANDS)).toBeNull();
  });

  it('stays silent exactly ON a threshold (nothing has spilled over yet)', () => {
    expect(bracketProximityMove(1_000_000, BANDS)).toBeNull();
  });

  it('stays silent for zero or negative income', () => {
    expect(bracketProximityMove(0, BANDS)).toBeNull();
    expect(bracketProximityMove(-500, BANDS)).toBeNull();
  });

  it('is driven by the shared provider tables, so it cannot drift a tax year again', () => {
    // The canonical 2025 US 12% threshold is $11,925. The inline copy this
    // replaced still said $11,600 (2024). Assert the advice keys off the
    // provider's threshold: $100 over it fires, $100 under it does not.
    const brackets = usTaxBrackets.getTaxBrackets(2025);
    const twelvePercent = brackets.find((b) => b.rate === 0.12);
    expect(twelvePercent?.min).toBe(1_192_500);

    expect(bracketProximityMove(1_192_500 + 10_000, brackets)).not.toBeNull();
    expect(bracketProximityMove(1_192_500 - 10_000, brackets)).toBeNull();
  });

  it('reports the same dollar figure in the description as in impactCents', () => {
    // The headline number and the machine-readable number disagreeing is how a
    // fabricated figure survives review.
    const move = bracketProximityMove(1_100_000, BANDS)!;
    expect(move.description).toContain(`$${(move.impactCents / 100).toFixed(0)}`);
  });
});
