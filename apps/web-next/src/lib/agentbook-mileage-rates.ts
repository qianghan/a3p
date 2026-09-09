/**
 * Mileage-rate lookup. Pure helper — no DB, no network.
 *
 * Sources:
 *   • US (IRS) — 67¢ per business mile for tax year 2025; 67¢ for 2024
 *     (IRS Notice 2024-08, published Dec 2023). The 2025 rate is the
 *     IRS-announced standard mileage rate (67¢/mi business use). One flat
 *     rate, no tiers.
 *   • CA (CRA) — automobile allowance rates. For 2026 (carrying forward
 *     2025's published table until CRA updates), the deductible per-km
 *     rate is 72¢/km for the first 5,000 km driven for business in the
 *     calendar year, and 66¢/km thereafter (extra 4¢/km in NT, NU, YT,
 *     not modelled — that's PR 5+ scope).
 *   • UK (HMRC) — Approved Mileage Allowance Payments (AMAP): 45p/mile for
 *     the first 10,000 business miles in the tax year, 25p/mile thereafter.
 *     Tiered here directly (like CA below) rather than delegated to the
 *     jurisdictions package's `ukMileageRate` — that helper computes a
 *     blended average rate over the *entire* cumulative total, which
 *     answers a different question ("what's my average rate for the
 *     year") than the one this file needs ("what flat rate applies to
 *     THIS new trip"); delegating to it here would overcharge tenants who
 *     are well past the 10,000-mile threshold instead of correctly
 *     applying the flat 25p/mile marginal rate.
 *
 * Boundary policy (MVP):
 *   We do NOT split a single trip across the 5,000 km / 10,000 mi boundary;
 *   whichever tier the cumulative-YTD-before-this-trip lands in is what the
 *   entire trip uses. The simpler rule keeps the journal entry single-line
 *   and reversible. Mid-trip splits land in a follow-up.
 *
 *   Worked example:
 *     Maya is at 4,990 km YTD (Canada tenant) and logs a 50 km trip.
 *     YTD-before-trip = 4,990 km is < 5,000 → LOW tier picked. The entry
 *     uses 72¢/km × 50 km = $36.00 for the entire trip, even though
 *     10 km of it technically crosses the 5,000 km boundary into the
 *     high-tier bucket. After this entry, YTD = 5,040 km, so her *next*
 *     trip will be billed at the HIGH tier (66¢/km).
 */

import 'server-only';
import { auMileageRate, auFinancialYearOf, auFinancialYearStart, usMileageRate } from '@agentbook/jurisdictions';

// The US rate is NOT redeclared here. It used to be — 67c, the 2024 figure —
// while the jurisdictions pack said 70c, and the shell is the copy that books
// the deduction. Every US user was under-claiming 3c/mile because the newer
// of two copies was the one nobody read. There is now one table, in the pack.

export const CRA_TIER_BREAK_KM = 5_000;
/**
 * CRA per-km rates, by year. These were bare constants, so the day the CRA
 * moved to 73c/67c for 2026 there was nowhere for the new numbers to go.
 */
const CRA_RATES_BY_YEAR: Record<number, { low: number; high: number }> = {
  2025: { low: 72, high: 66 },
  2026: { low: 73, high: 67 },
};
/** Latest year the CRA table holds — asserted by the staleness test. */
export const CRA_LATEST_YEAR = 2026;
const craRates = (year: number) => CRA_RATES_BY_YEAR[year] ?? CRA_RATES_BY_YEAR[CRA_LATEST_YEAR];

// Kept as exports because tests and callers reference them; they now name the
// CURRENT year's tiers rather than a frozen pair.
export const CRA_LOW_TIER_CENTS_PER_KM = CRA_RATES_BY_YEAR[CRA_LATEST_YEAR].low;
export const CRA_HIGH_TIER_CENTS_PER_KM = CRA_RATES_BY_YEAR[CRA_LATEST_YEAR].high;

export const HMRC_TIER_BREAK_MILES = 10_000;
export const HMRC_LOW_TIER_PENCE_PER_MI = 45;
export const HMRC_HIGH_TIER_PENCE_PER_MI = 25;

export interface RateLookup {
  ratePerUnitCents: number;
  unit: 'mi' | 'km';
  reason: string;
  /**
   * Distance claimable under this method for the WHOLE period, or undefined
   * where the method has no ceiling (US, CA, UK all tier rather than cap).
   *
   * A cap is not a tier. Past a tier break the next kilometre is worth less;
   * past a cap it is worth nothing under this method and the taxpayer has to
   * switch methods entirely.
   */
  maxClaimableUnitsPerYear?: number;
}

/**
 * Resolve the per-unit deductible mileage rate for a given trip.
 *
 * @param jurisdiction `'us'` (mile-based, flat), `'ca'` (km-based, tiered),
 *                      `'au'` (km-based, flat ATO cents-per-km method), or
 *                      `'uk'` (mile-based, HMRC AMAP tiered).
 * @param year         calendar year of the trip (used for US rate lookup).
 * @param milesOrKmThisYear
 *   total miles (US/UK) or km (CA) the user has already accumulated **this
 *   calendar year** before this trip. Drives CRA/HMRC tier selection;
 *   ignored for US/AU. Pass `0` if this is the first trip of the year.
 *
 * @returns rate in cents per unit, the unit (`mi` or `km`), and a short
 *   `reason` string suitable for memo lines / audit logs.
 *
 * Throws if `jurisdiction` is anything other than `'us'` / `'ca'` / `'au'` / `'uk'`.
 */
export function getMileageRate(
  jurisdiction: 'us' | 'ca' | 'au' | 'uk',
  year: number,
  milesOrKmThisYear: number,
  asOf?: Date,
): RateLookup {
  if (jurisdiction === 'us') {
    // Straight from the pack, including the mid-year change: the IRS moved
    // from 72.5c to 76c on 1 July 2026, which a year-keyed lookup cannot
    // express. `asOf` carries the trip's own date when the caller has it.
    const r = usMileageRate.getRate(year, 0, asOf);
    return {
      ratePerUnitCents: r.rate * 100,
      unit: 'mi',
      reason: r.tierDescription ?? `IRS standard mileage rate, ${year}`,
    };
  }

  if (jurisdiction === 'ca') {
    // Tier selection uses STRICT-less-than against the break: someone
    // standing at exactly 5,000 km YTD has fully consumed the low-tier
    // bucket and starts the next trip in the high tier.
    const { low, high } = craRates(year);
    if (milesOrKmThisYear < CRA_TIER_BREAK_KM) {
      return {
        ratePerUnitCents: low,
        unit: 'km',
        reason: `CRA reasonable per-km rate, ${year}, first ${CRA_TIER_BREAK_KM.toLocaleString('en-CA')} km tier (${low}¢/km)`,
      };
    }
    return {
      ratePerUnitCents: high,
      unit: 'km',
      reason: `CRA reasonable per-km rate, ${year}, after ${CRA_TIER_BREAK_KM.toLocaleString('en-CA')} km (${high}¢/km)`,
    };
  }

  if (jurisdiction === 'au') {
    // ATO cents-per-km method — a flat rate, but CAPPED at 5,000 km per
    // vehicle per income year. The cap used to be dropped here on the
    // grounds that "the rate doesn't change", which is true and beside the
    // point: km past the cap are not claimable under this method at all.
    // `year` is the AU income year (FY ending), not a calendar year — see
    // `mileageRateYear`.
    const ato = auMileageRate.getRate(year, milesOrKmThisYear);
    return {
      ratePerUnitCents: Math.round(ato.rate * 100),
      unit: 'km',
      reason: `ATO cents-per-km rate, FY${year - 1}-${String(year).slice(2)} (${Math.round(ato.rate * 100)}¢/km)`,
      maxClaimableUnitsPerYear: ato.maxClaimableUnitsPerYear,
    };
  }

  if (jurisdiction === 'uk') {
    // HMRC AMAP method — tiered like CA (flat rate per whichever bucket
    // YTD-before-this-trip lands in), but on a mileage (not km) basis.
    if (milesOrKmThisYear < HMRC_TIER_BREAK_MILES) {
      return {
        ratePerUnitCents: HMRC_LOW_TIER_PENCE_PER_MI,
        unit: 'mi',
        reason: `HMRC AMAP rate, first ${HMRC_TIER_BREAK_MILES.toLocaleString('en-GB')} miles tier (45p/mi)`,
      };
    }
    return {
      ratePerUnitCents: HMRC_HIGH_TIER_PENCE_PER_MI,
      unit: 'mi',
      reason: `HMRC AMAP rate, after ${HMRC_TIER_BREAK_MILES.toLocaleString('en-GB')} miles (25p/mi)`,
    };
  }

  throw new Error(
    `Unknown jurisdiction "${jurisdiction}" — supported: 'us' | 'ca' | 'au' | 'uk'`,
  );
}

// =============================================================================
// THE PERIOD, AND THE ONE PLACE A DEDUCTION IS COMPUTED
// =============================================================================
// Three write paths book mileage: the POST route, the PATCH service, and the
// chat/bot executor. Each used to derive the period, look up the rate and do
// the `distance x rate` multiply itself, which meant an AU sole trader who
// logged a trip through chat got a different (and wrong) answer from one who
// used the app. The rule now lives here and all three call it.
//
// See `mileage-cap.test.ts`, which asserts no other file does the multiply.

/**
 * The tax year whose rate table applies to a trip.
 *
 * Australia's income year runs 1 Jul – 30 Jun, so a trip on 15 Aug 2024 falls
 * in FY2024-25 and takes the 88c rate — not the 85c rate keyed to calendar
 * 2024. Everywhere else the calendar year is the tax year.
 */
export function mileageRateYear(jurisdiction: 'us' | 'ca' | 'au' | 'uk', tripDate: Date): number {
  return jurisdiction === 'au' ? auFinancialYearOf(tripDate) : tripDate.getUTCFullYear();
}

/**
 * First day of the period that tiers and caps accumulate over, for a trip on
 * `tripDate`. AU accumulates over its income year; everyone else over the
 * calendar year.
 *
 * Callers sum distance in `[periodStart, tripDate)` — strictly before the trip,
 * so backdating an entry cannot let later trips influence its own rate.
 */
export function mileagePeriodStart(jurisdiction: 'us' | 'ca' | 'au' | 'uk', tripDate: Date): Date {
  if (jurisdiction === 'au') return auFinancialYearStart(auFinancialYearOf(tripDate));
  return new Date(Date.UTC(tripDate.getUTCFullYear(), 0, 1));
}

export interface MileageDeduction extends RateLookup {
  /** Distance actually claimable on this trip, after any annual method cap. */
  claimableUnits: number;
  /** What goes in the books. `claimableUnits x ratePerUnitCents`, rounded. */
  deductibleAmountCents: number;
  /**
   * Set only when the cap reduced THIS trip's claim — user-facing text naming
   * the alternative, because "your deduction is smaller than the arithmetic
   * suggests" is not something to leave the user to discover at lodgment.
   */
  capNote: string | null;
}

/**
 * Resolve what a single trip is worth.
 *
 * @param unitsThisTrip      distance recorded on this trip
 * @param unitsPriorInPeriod distance already booked in the period BEFORE it
 * @param entryUnit          the unit the entry is stored in
 */
export function resolveMileageDeduction(
  jurisdiction: 'us' | 'ca' | 'au' | 'uk',
  tripDate: Date,
  unitsThisTrip: number,
  unitsPriorInPeriod: number,
  entryUnit: 'mi' | 'km',
): MileageDeduction {
  const rate = getMileageRate(jurisdiction, mileageRateYear(jurisdiction, tripDate), unitsPriorInPeriod, tripDate);

  const cap = rate.maxClaimableUnitsPerYear;
  // The cap is a distance, so it only means anything when the entry is stored
  // in the same unit the rate is quoted in. A km cap applied to a mileage
  // figure would be a second wrong answer on top of the unit mismatch that
  // produced it, so in that case we cap nothing and let the mismatch stand
  // as the single visible problem.
  const capApplies = cap !== undefined && entryUnit === rate.unit;

  const claimableUnits = capApplies
    ? Math.min(unitsThisTrip, Math.max(0, cap - unitsPriorInPeriod))
    : unitsThisTrip;

  const shortfall = unitsThisTrip - claimableUnits;
  const capNote = shortfall > 0
    ? `Only ${claimableUnits.toLocaleString('en-AU')} of ${unitsThisTrip.toLocaleString('en-AU')} ${entryUnit} is deductible: the ATO cents-per-km method is capped at ${cap!.toLocaleString('en-AU')} km per vehicle per income year, and ${unitsPriorInPeriod.toLocaleString('en-AU')} km is already claimed. To claim the rest, switch this vehicle to the logbook method, which needs a 12-week logbook and actual running costs.`
    : null;

  return {
    ...rate,
    claimableUnits,
    deductibleAmountCents: Math.round(claimableUnits * rate.ratePerUnitCents),
    capNote,
  };
}
