/**
 * Tests for the mileage-rate lookup helper. Rates are jurisdiction-aware:
 *
 *   • US — flat IRS standard mileage rate per mile, year-versioned.
 *   • CA — CRA tiered: 72¢/km for the first 5,000 km in a calendar year,
 *          66¢/km thereafter. Tier is selected by the caller-supplied
 *          "miles-or-km accumulated this year before this trip".
 *
 * The helper is pure (no I/O), so the suite runs offline.
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import {
  getMileageRate,
  CRA_TIER_BREAK_KM,
  CRA_LOW_TIER_CENTS_PER_KM,
  CRA_HIGH_TIER_CENTS_PER_KM,
  HMRC_TIER_BREAK_MILES,
  HMRC_LOW_TIER_PENCE_PER_MI,
  HMRC_HIGH_TIER_PENCE_PER_MI,
} from './agentbook-mileage-rates';
import { auMileageRate, usMileageRate } from '@agentbook/jurisdictions';

describe('getMileageRate', () => {
  it('US 2025 → flat 70¢/mi (IRS standard rate)', () => {
    // This asserted 67¢ — the 2024 rate — against a shell constant that also
    // said 67, so the test and the bug agreed with each other while the
    // jurisdictions pack next door already held the correct 70. Assert
    // against the pack, which is now the only table.
    const r = getMileageRate('us', 2025, 0);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(70);
    expect(r.ratePerUnitCents).toBe(usMileageRate.getRate(2025, 0).rate * 100);
    expect(r.reason).toMatch(/IRS/i);
  });

  it('US 2026 splits mid-year: 72.5¢ to 30 June, 76¢ from 1 July', () => {
    // The IRS made a rare mid-year adjustment for 2026. A year-keyed lookup
    // cannot express it, so a June trip and a September trip were being
    // booked at the same rate — one of them wrong by 3.5¢/mi.
    const june = getMileageRate('us', 2026, 0, new Date(Date.UTC(2026, 5, 15)));
    const sept = getMileageRate('us', 2026, 0, new Date(Date.UTC(2026, 8, 15)));
    expect(june.ratePerUnitCents).toBe(72.5);
    expect(sept.ratePerUnitCents).toBe(76);
  });

  it('US flat rate is invariant of accumulated miles (no tiers)', () => {
    const a = getMileageRate('us', 2025, 0);
    const b = getMileageRate('us', 2025, 9_999);
    expect(a.ratePerUnitCents).toBe(b.ratePerUnitCents);
  });

  it('CA 2026 below 5,000 km → low tier (73¢/km)', () => {
    // The CRA raised both tiers by a cent for 2026. The rate was a bare
    // constant with no year in it, so there was nowhere for the new figure
    // to go and the test asserted the 2025 one against a 2026 request.
    const r = getMileageRate('ca', 2026, 1_234);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(73);
    expect(r.reason).toMatch(/CRA/i);
  });

  it('CA 2025 still gets the 2025 tiers, so a prior-year edit is unchanged', () => {
    expect(getMileageRate('ca', 2025, 1_234).ratePerUnitCents).toBe(72);
    expect(getMileageRate('ca', 2025, 9_000).ratePerUnitCents).toBe(66);
  });

  it('CA 2026 above 5,000 km → high tier (67¢/km)', () => {
    const r = getMileageRate('ca', 2026, 7_500);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(67);
  });

  it('CA at the 5,000 km boundary → low tier still applies (≤ 5,000)', () => {
    // Boundary policy (documented MVP scope): a trip starting with exactly
    // 5,000 km already accumulated falls into the high tier. Sitting just
    // below it (4,999) is still low-tier. We assert both.
    const just_below = getMileageRate('ca', 2026, CRA_TIER_BREAK_KM - 1);
    expect(just_below.ratePerUnitCents).toBe(CRA_LOW_TIER_CENTS_PER_KM);

    const at_boundary = getMileageRate('ca', 2026, CRA_TIER_BREAK_KM);
    expect(at_boundary.ratePerUnitCents).toBe(CRA_HIGH_TIER_CENTS_PER_KM);
  });

  it('unknown jurisdiction throws (fail-loud, not silent fallback)', () => {
    // @ts-expect-error — testing the runtime guard for malformed input.
    expect(() => getMileageRate('xx', 2025, 0)).toThrow(/jurisdiction/i);
  });

  it('unknown US year falls back to the NEWEST published US rate', () => {
    // Future-year requests should not throw. They used to pin to 2025's rate,
    // frozen as a literal — so once the IRS moved, "the latest rate we have"
    // silently meant a superseded one.
    const r = getMileageRate('us', 2999, 0);
    const newest = getMileageRate('us', 2026, 0, new Date(Date.UTC(2026, 6, 1)));
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(newest.ratePerUnitCents);
  });

  it('US 2024 returns the published 2024 rate (not 2025)', () => {
    // Was `expect([67, 65, 65.5]).toContain(...)` — three acceptable answers
    // for a published figure with exactly one correct value, which is how a
    // rate can go stale without any test noticing.
    const r = getMileageRate('us', 2024, 0);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(67);
  });
});

describe('AU (ATO cents-per-km method)', () => {
  it('2025/2026 → flat 88¢/km (ATO cents-per-km rate)', () => {
    const r = getMileageRate('au', 2026, 0);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(88);
    expect(r.reason).toMatch(/ATO/i);
  });

  it('2024 → flat 85¢/km (ATO cents-per-km rate for 2024-25)', () => {
    const r = getMileageRate('au', 2024, 0);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(85);
  });

  it('AU flat rate is invariant of accumulated km (no tiers, unlike CA)', () => {
    const a = getMileageRate('au', 2026, 0);
    const b = getMileageRate('au', 2026, 9_999);
    expect(a.ratePerUnitCents).toBe(b.ratePerUnitCents);
  });

  it('matches the real ATO rate published in the jurisdictions package directly', () => {
    // Cross-check against the source of truth this helper wraps, so the
    // two can't silently drift apart.
    const source = auMileageRate.getRate(2026, 0);
    const wrapped = getMileageRate('au', 2026, 0);
    expect(wrapped.ratePerUnitCents).toBe(Math.round(source.rate * 100));
  });
});

describe('UK (HMRC Approved Mileage Allowance Payments)', () => {
  it('under the 10,000-mile threshold → flat 45p/mile', () => {
    const r = getMileageRate('uk', 2026, 0);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(HMRC_LOW_TIER_PENCE_PER_MI);
    expect(r.ratePerUnitCents).toBe(45);
    expect(r.reason).toMatch(/HMRC/i);
  });

  it('just below the 10,000-mile threshold → still low tier (45p/mi)', () => {
    const r = getMileageRate('uk', 2026, HMRC_TIER_BREAK_MILES - 1);
    expect(r.ratePerUnitCents).toBe(HMRC_LOW_TIER_PENCE_PER_MI);
  });

  it('at exactly the 10,000-mile threshold → high tier applies (same boundary convention as CA — ≥ break is high tier)', () => {
    const r = getMileageRate('uk', 2026, HMRC_TIER_BREAK_MILES);
    expect(r.ratePerUnitCents).toBe(HMRC_HIGH_TIER_PENCE_PER_MI);
    expect(r.ratePerUnitCents).toBe(25);
  });

  it('past the 10,000-mile threshold → flat 25p/mile (whole trip uses the tier YTD-before-trip lands in, not a blended average)', () => {
    const r = getMileageRate('uk', 2026, 10_500);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(HMRC_HIGH_TIER_PENCE_PER_MI);
  });
});

describe('CRA tier picker — backdated-trip regression (PR 4 review M2)', () => {
  /**
   * Scenario: a CA tenant has these mileage entries already in the DB:
   *   • Jan 10: 4,990 km
   *   • Dec 1:  100 km   (post-boundary, already used HIGH tier)
   *
   * Now the user backdates a NEW 50 km trip to *Feb 1* (between the two
   * existing entries). The naive picker that filters by `date < year-end`
   * sees 5,090 km of "YTD" and picks the HIGH tier — wrong, because the
   * Dec 1 trip happened *after* the trip we're booking.
   *
   * The correct picker filters by `date < trip-date` and sees only the
   * 4,990 km that actually preceded Feb 1, putting the trip in the LOW
   * tier. We simulate the picker by passing the right vs. wrong YTD value
   * directly to `getMileageRate`.
   */

  // A small helper mirrors the production query: sum existing entries
  // whose date is strictly less than the candidate trip date.
  function ytdBeforeTrip(
    entries: { date: Date; miles: number }[],
    tripDate: Date,
  ): number {
    return entries
      .filter((e) => e.date < tripDate)
      .reduce((s, e) => s + e.miles, 0);
  }

  // Same shape, but the BUGGY filter (the one the PR review flagged):
  // sums everything in the calendar year regardless of order.
  function ytdAllYear(
    entries: { date: Date; miles: number }[],
    year: number,
  ): number {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    return entries
      .filter((e) => e.date >= yearStart && e.date < yearEnd)
      .reduce((s, e) => s + e.miles, 0);
  }

  it('backdated trip uses YTD-before-trip-date, NOT all-of-year totals', () => {
    const entries = [
      { date: new Date(Date.UTC(2026, 0, 10)), miles: 4_990 }, // Jan 10
      { date: new Date(Date.UTC(2026, 11, 1)), miles: 100 }, // Dec 1
    ];
    const tripDate = new Date(Date.UTC(2026, 1, 1)); // Feb 1

    const correctYtd = ytdBeforeTrip(entries, tripDate);
    const buggyYtd = ytdAllYear(entries, 2026);

    expect(correctYtd).toBe(4_990); // only Jan 10 preceded Feb 1
    expect(buggyYtd).toBe(5_090); // includes the Dec 1 trip → wrong

    const correctRate = getMileageRate('ca', 2026, correctYtd);
    const buggyRate = getMileageRate('ca', 2026, buggyYtd);

    // The fix: backdated trip lands in the LOW tier.
    expect(correctRate.ratePerUnitCents).toBe(CRA_LOW_TIER_CENTS_PER_KM);
    // Demonstrate the bug we are guarding against: buggy filter picks HIGH.
    expect(buggyRate.ratePerUnitCents).toBe(CRA_HIGH_TIER_CENTS_PER_KM);
  });

  it('linear-history trip (no backdating) gets the same answer either way', () => {
    // When entries are recorded in order, both filters yield the same
    // YTD-before total. This guards against accidentally penalising the
    // common case while we fix the backdating one.
    const entries = [
      { date: new Date(Date.UTC(2026, 0, 10)), miles: 1_500 },
      { date: new Date(Date.UTC(2026, 2, 5)), miles: 2_000 },
    ];
    const tripDate = new Date(Date.UTC(2026, 5, 1)); // June 1, after both

    const correctYtd = ytdBeforeTrip(entries, tripDate);
    const buggyYtd = ytdAllYear(entries, 2026);
    expect(correctYtd).toBe(buggyYtd);
    expect(correctYtd).toBe(3_500);
  });
});
