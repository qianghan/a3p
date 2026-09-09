import type { MileageRateProvider, MileageRate } from '../interfaces.js';

// ATO cents per kilometre method — flat rate for 2024-25
// 88 cents per km (no tiering, max 5,000 km for this method)
const ATO_RATE_PER_KM: Record<number, number> = {
  2024: 0.85,
  2025: 0.88,
  2026: 0.88,
};

const MAX_KM_CENTS_METHOD = 5000;

export const auMileageRate: MileageRateProvider = {
  getRate(taxYear: number, totalKm: number): MileageRate {
    const rate = ATO_RATE_PER_KM[taxYear] ?? 0.88;

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
