import type { MileageRateProvider, MileageRate } from '../interfaces.js';

/**
 * IRS business standard mileage rate.
 *
 * KEYED BY EFFECTIVE DATE, NOT BY YEAR. The IRS normally sets one rate per
 * calendar year, but it can and does move mid-year when fuel costs jump — it
 * did so in 2022 and again in 2026. A year-keyed table cannot express that,
 * and rounding a half-year to whichever rate is "mostly" right mis-states
 * every trip in the other half.
 *
 * This table is also the ONLY copy. `apps/web-next/src/lib/agentbook-mileage-
 * rates.ts` used to carry its own, and the two had silently diverged: the
 * pack said 70c while the shell — the one that actually books the deduction —
 * still said 67c, the 2024 rate. Everyone's US mileage was being under-claimed
 * by 3c/mile, and the newer of the two copies was the one nobody used.
 *
 * Rates are cents per mile and may be fractional: 72.5c is the IRS's own
 * figure for the first half of 2026, not a rounding of anything.
 */
interface RatePeriod {
  /** First day the rate applies, inclusive, as UTC midnight. */
  from: Date;
  centsPerMile: number;
  label: string;
}

/** Newest first — `rateForDate` takes the first period that has begun. */
const US_RATE_PERIODS: RatePeriod[] = [
  { from: new Date(Date.UTC(2026, 6, 1)), centsPerMile: 76, label: '2026 (from 1 Jul)' },
  { from: new Date(Date.UTC(2026, 0, 1)), centsPerMile: 72.5, label: '2026 (Jan–Jun)' },
  { from: new Date(Date.UTC(2025, 0, 1)), centsPerMile: 70, label: '2025' },
  { from: new Date(Date.UTC(2024, 0, 1)), centsPerMile: 67, label: '2024' },
];

/**
 * The most recent period we hold. Exported so a staleness test can assert the
 * table still covers today — the drift this file documents went unnoticed for
 * a year because nothing ever checked.
 */
export const US_MILEAGE_TABLE_COVERS_FROM = US_RATE_PERIODS[US_RATE_PERIODS.length - 1].from;
export const US_MILEAGE_LATEST_PERIOD_FROM = US_RATE_PERIODS[0].from;

export interface UsMileageRate {
  centsPerMile: number;
  /** Human label for the period applied, for memo lines and audit trails. */
  label: string;
  /** True when the date predates our earliest period and we fell back. */
  extrapolated: boolean;
}

/**
 * Resolve the rate for a specific date.
 *
 * A date after our newest period takes that period's rate: failing forward is
 * right for a trip logged on 2 January before the new determination is
 * published, and the staleness test is what stops that becoming permanent.
 */
export function usMileageRateForDate(asOf: Date): UsMileageRate {
  for (const p of US_RATE_PERIODS) {
    if (asOf >= p.from) return { centsPerMile: p.centsPerMile, label: p.label, extrapolated: false };
  }
  const oldest = US_RATE_PERIODS[US_RATE_PERIODS.length - 1];
  return { centsPerMile: oldest.centsPerMile, label: oldest.label, extrapolated: true };
}

export const usMileageRate: MileageRateProvider = {
  getRate(taxYear: number, _totalMiles: number, asOf?: Date): MileageRate {
    // `asOf` is what makes a mid-year change expressible. Without it we can
    // only place the trip within a year, so we take the rate in force at the
    // START of that year — which is the best available answer and is exactly
    // right for every year the IRS did not move mid-way.
    const when = asOf ?? new Date(Date.UTC(taxYear, 0, 1));
    const r = usMileageRateForDate(when);
    return {
      rate: r.centsPerMile / 100,
      unit: 'mile',
      tierDescription: `IRS standard mileage rate, ${r.label} (${r.centsPerMile}¢/mi)`,
    };
  },
};
