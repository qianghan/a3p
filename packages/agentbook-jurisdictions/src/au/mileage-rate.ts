import type { MileageRateProvider, MileageRate } from '../interfaces.js';

// ATO cents per kilometre method, keyed by the INCOME YEAR (the year the
// financial year ends in): 2027 is FY2026-27, which began 1 July 2026.
// No tiering, and capped at 5,000 km for this method.
//   FY2023-24  85c    FY2024-25  88c    FY2025-26  88c    FY2026-27  91c
// 91c x 5,000 km = A$4,550, the maximum claim the ATO publishes for
// 2026-27 — which is also a check on the cap below.
const ATO_RATE_PER_KM: Record<number, number> = {
  2024: 0.85,
  2025: 0.88,
  2026: 0.88,
  2027: 0.91,
};

/** Latest income year the table holds — asserted by the staleness test. */
export const AU_MILEAGE_LATEST_YEAR = 2027;

const MAX_KM_CENTS_METHOD = 5000;

export const auMileageRate: MileageRateProvider = {
  getRate(taxYear: number, totalKm: number): MileageRate {
    // Fail forward to the newest rate we hold rather than a frozen literal:
    // a hardcoded default silently becomes last year's rate every July.
    const rate = ATO_RATE_PER_KM[taxYear] ?? ATO_RATE_PER_KM[AU_MILEAGE_LATEST_YEAR];

    // The cap is returned as a NUMBER, always — not only as prose past the
    // threshold. It used to be carried in `tierDescription` alone, so callers
    // multiplied rate x distance with no ceiling and an AU sole trader logging
    // 12,000 km claimed A$10,560 where the ATO allows A$4,400.
    if (totalKm > MAX_KM_CENTS_METHOD) {
      return {
        rate,
        unit: 'km',
        maxClaimableUnitsPerYear: MAX_KM_CENTS_METHOD,
        tierDescription: `${rate * 100}c/km (cents per km method capped at ${MAX_KM_CENTS_METHOD} km — use the logbook method for higher distances)`,
      };
    }

    return {
      rate,
      unit: 'km',
      maxClaimableUnitsPerYear: MAX_KM_CENTS_METHOD,
      tierDescription: `ATO rate ${rate * 100}c/km`,
    };
  },
};
