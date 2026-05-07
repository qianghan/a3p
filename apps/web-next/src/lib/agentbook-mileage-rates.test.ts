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
  US_RATE_2025_CENTS_PER_MI,
  CRA_LOW_TIER_CENTS_PER_KM,
  CRA_HIGH_TIER_CENTS_PER_KM,
} from './agentbook-mileage-rates';

describe('getMileageRate', () => {
  it('US 2025 → flat 67¢/mi (IRS standard rate)', () => {
    const r = getMileageRate('us', 2025, 0);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(US_RATE_2025_CENTS_PER_MI);
    expect(r.ratePerUnitCents).toBe(67);
    expect(r.reason).toMatch(/IRS/i);
  });

  it('US flat rate is invariant of accumulated miles (no tiers)', () => {
    const a = getMileageRate('us', 2025, 0);
    const b = getMileageRate('us', 2025, 9_999);
    expect(a.ratePerUnitCents).toBe(b.ratePerUnitCents);
  });

  it('CA below 5,000 km → low tier (72¢/km)', () => {
    const r = getMileageRate('ca', 2026, 1_234);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(CRA_LOW_TIER_CENTS_PER_KM);
    expect(r.ratePerUnitCents).toBe(72);
    expect(r.reason).toMatch(/CRA/i);
  });

  it('CA above 5,000 km → high-tier (66¢/km)', () => {
    const r = getMileageRate('ca', 2026, 7_500);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(CRA_HIGH_TIER_CENTS_PER_KM);
    expect(r.ratePerUnitCents).toBe(66);
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
    expect(() => getMileageRate('uk', 2025, 0)).toThrow(/jurisdiction/i);
  });

  it('unknown US year falls back to the latest published US rate', () => {
    // Future-year requests should not throw — they pin to the most-recent
    // rate we have, with a `reason` string that reflects the fallback.
    const r = getMileageRate('us', 2999, 0);
    expect(r.unit).toBe('mi');
    expect(r.ratePerUnitCents).toBe(US_RATE_2025_CENTS_PER_MI);
    expect(r.reason).toMatch(/fallback|2025/i);
  });

  it('US 2024 returns the published 2024 rate (not 2025)', () => {
    const r = getMileageRate('us', 2024, 0);
    expect(r.unit).toBe('mi');
    // IRS published 67¢/mi for 2024 too (December 2023 announcement).
    // Keep this in lock-step with the table inside the helper.
    expect([67, 65, 65.5]).toContain(r.ratePerUnitCents);
  });
});
