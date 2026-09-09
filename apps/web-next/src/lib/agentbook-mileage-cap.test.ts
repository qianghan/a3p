import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  resolveMileageDeduction,
  mileagePeriodStart,
  mileageRateYear,
  getMileageRate,
} from './agentbook-mileage-rates';

// The module is `import 'server-only'`; vitest resolves the client build,
// which throws on import. Same stub the sibling rate test uses.
vi.mock('server-only', () => ({}));

/**
 * The ATO cents-per-km cap.
 *
 * Australia's cents-per-km method is capped at 5,000 km per vehicle per income
 * year. We knew that — the jurisdictions pack has carried a `MAX_KM_CENTS_METHOD
 * = 5000` constant since the AU pack was written — but the constant was only
 * ever interpolated into an advisory string, and every one of the three write
 * paths computed `distance x rate` with no ceiling. An AU sole trader logging
 * 12,000 km was told A$10,560 was deductible when the ATO allows A$4,400, and
 * the full amount was posted to the journal as a real expense.
 *
 * A deduction that errs in the taxpayer's favour is the kind that gets
 * penalised, so these are money-correctness tests, not formatting ones.
 */

const AUG_2025 = new Date(Date.UTC(2025, 7, 15)); // FY2025-26
const MAR_2026 = new Date(Date.UTC(2026, 2, 15)); // also FY2025-26
const AUG_2024 = new Date(Date.UTC(2024, 7, 15)); // FY2024-25

describe('the 5,000 km cap is applied, not merely described', () => {
  it('a single 12,000 km trip claims 5,000 km, not 12,000', () => {
    const d = resolveMileageDeduction('au', AUG_2025, 12_000, 0, 'km');
    expect(d.claimableUnits).toBe(5_000);
    // 5,000 km x 88c = A$4,400. The bug produced A$10,560.
    expect(d.deductibleAmountCents).toBe(440_000);
    expect(d.deductibleAmountCents).not.toBe(12_000 * 88);
  });

  it('the cap counts what the year already used, not just this trip', () => {
    // 4,000 km already booked; a 2,000 km trip can only use the last 1,000.
    const d = resolveMileageDeduction('au', AUG_2025, 2_000, 4_000, 'km');
    expect(d.claimableUnits).toBe(1_000);
    expect(d.deductibleAmountCents).toBe(88_000);
  });

  it('a trip after the cap is fully consumed deducts nothing', () => {
    const d = resolveMileageDeduction('au', AUG_2025, 500, 5_000, 'km');
    expect(d.claimableUnits).toBe(0);
    expect(d.deductibleAmountCents).toBe(0);
    // Never negative, however far past the cap the year has run.
    expect(resolveMileageDeduction('au', AUG_2025, 500, 40_000, 'km').claimableUnits).toBe(0);
  });

  it('leaves a trip under the cap completely alone', () => {
    const d = resolveMileageDeduction('au', AUG_2025, 120, 300, 'km');
    expect(d.claimableUnits).toBe(120);
    expect(d.deductibleAmountCents).toBe(120 * 88);
    expect(d.capNote).toBeNull();
  });

  it('tells the user why the number is short, and what to do instead', () => {
    // Silently returning a smaller figure than distance x rate reads as an
    // arithmetic bug. The note has to name the alternative method.
    const { capNote } = resolveMileageDeduction('au', AUG_2025, 12_000, 0, 'km');
    expect(capNote).toBeTruthy();
    expect(capNote).toMatch(/5,000 km/);
    expect(capNote).toMatch(/logbook/i);
  });
});

describe('the cap is scoped to Australia and to kilometres', () => {
  it('CA tiers past 5,000 km but does not cap — the full trip stays deductible', () => {
    const d = resolveMileageDeduction('ca', AUG_2025, 12_000, 0, 'km');
    expect(d.claimableUnits).toBe(12_000);
    expect(d.capNote).toBeNull();
  });

  it.each(['us', 'uk'] as const)('%s has no annual ceiling', (j) => {
    const unit = 'mi' as const;
    const d = resolveMileageDeduction(j, AUG_2025, 30_000, 0, unit);
    expect(d.claimableUnits).toBe(30_000);
    expect(d.maxClaimableUnitsPerYear).toBeUndefined();
  });

  it('does not apply a km cap to an entry recorded in miles', () => {
    // An AU tenant recording "mi" is already a unit mismatch. Capping a mile
    // count against a kilometre limit would layer a second wrong answer on
    // top of it; leave the one visible problem visible.
    const d = resolveMileageDeduction('au', AUG_2025, 12_000, 0, 'mi');
    expect(d.claimableUnits).toBe(12_000);
    expect(d.capNote).toBeNull();
  });
});

describe('the Australian period is the income year, not the calendar year', () => {
  it('accumulates from 1 July', () => {
    // Both dates sit in FY2025-26, so both must look back to 1 Jul 2025 —
    // a calendar-year window would reset the cap on 1 January, half way
    // through the income year, and hand back a second 5,000 km allowance.
    expect(mileagePeriodStart('au', AUG_2025).toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(mileagePeriodStart('au', MAR_2026).toISOString()).toBe('2025-07-01T00:00:00.000Z');
  });

  it('leaves every other jurisdiction on 1 January', () => {
    for (const j of ['us', 'ca', 'uk'] as const) {
      expect(mileagePeriodStart(j, MAR_2026).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('picks the AU rate by income year, so an August trip is not last year', () => {
    // 15 Aug 2024 falls in FY2024-25, whose rate is 88c. Keying the lookup on
    // the calendar year returned the FY2023-24 rate of 85c — 3c/km wrong on
    // every trip taken between July and December.
    expect(mileageRateYear('au', AUG_2024)).toBe(2025);
    expect(resolveMileageDeduction('au', AUG_2024, 100, 0, 'km').ratePerUnitCents).toBe(88);
    expect(getMileageRate('au', 2024, 0).ratePerUnitCents).toBe(85);
  });

  it('keeps the calendar year everywhere else', () => {
    expect(mileageRateYear('ca', AUG_2024)).toBe(2024);
    expect(mileageRateYear('us', AUG_2024)).toBe(2024);
  });
});

describe('one place does the multiply', () => {
  it('no other source file turns a rate into an amount', () => {
    // The cap was missing from all three write paths at once because each one
    // did its own `distance x rate`. Fixing them individually would leave the
    // fourth caller free to reintroduce it, so the arithmetic now lives in
    // agentbook-mileage-rates.ts alone and this asserts it stays there.
    const root = join(__dirname, '..', '..', '..', '..');
    let out: string[] = [];
    try {
      out = execFileSync('git', [
        // POSIX ERE, which is what git grep speaks: `\s` is NOT a space class
        // here, it is a literal `s`, and a pattern using it silently matches
        // nothing. `--untracked` so a newly added file is scanned too.
        'grep', '-n', '-E', '--untracked',
        String.raw`(\*[[:space:]]*[A-Za-z_.]*ratePerUnitCents|ratePerUnitCents[[:space:]]*\*)`,
        '--', 'apps/web-next/src', 'plugins/*/backend/src', 'packages/*/src',
      ], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch (e) {
      // git grep exits 1 on NO MATCHES, which is the state we want. Anything
      // else (128: not a repo, bad pathspec) must fail loudly rather than
      // read as a clean result — a guard that passes when it cannot run is
      // the same as no guard.
      if ((e as { status?: number }).status !== 1) throw e;
    }

    // The rates module is where the multiply belongs; this file matches its
    // own pattern literal.
    const allowed = ['apps/web-next/src/lib/agentbook-mileage-rates.', 'apps/web-next/src/lib/agentbook-mileage-cap.test.ts'];
    const offenders = out.filter((l) => !allowed.some((a) => l.startsWith(a)));
    // The scan itself has to be known-working: if the pattern or the pathspec
    // stops matching anything at all, an empty `offenders` means nothing.
    expect(out.length, 'the guard matched nothing — pattern or pathspec is broken').toBeGreaterThan(0);
    expect(offenders, `compute the deduction via resolveMileageDeduction():\n${offenders.join('\n')}`).toEqual([]);
  });
});
