import type { MileageRateProvider, MileageRate } from '../interfaces.js';

// CRA automobile allowance rates (per km).
//   2025: $0.72 first 5,000 km, $0.66 thereafter
//   2026: $0.73 first 5,000 km, $0.67 thereafter
// The 2026 entries were copies of 2025 — placeholders that read as data. A
// year present in the table with last year's numbers is worse than a year
// missing from it, because the `??` fallback below is at least honest about
// guessing.
const FIRST_TIER_RATES: Record<number, number> = { 2025: 0.72, 2026: 0.73 };
const SECOND_TIER_RATES: Record<number, number> = { 2025: 0.66, 2026: 0.67 };
const TIER_THRESHOLD_KM = 5000;

/** Latest year the table actually holds — asserted by the staleness test. */
export const CA_MILEAGE_LATEST_YEAR = 2026;
// NOT MODELLED: the CRA allows an extra 4c/km in the Northwest Territories,
// Yukon and Nunavut. `getRate` has no region, so a territories resident is
// under-claimed by 4c/km. Tracked separately rather than widened here.

export const caMileageRate: MileageRateProvider = {
  getRate(taxYear: number, totalKm: number): MileageRate {
    const firstRate = FIRST_TIER_RATES[taxYear] ?? FIRST_TIER_RATES[CA_MILEAGE_LATEST_YEAR];
    const secondRate = SECOND_TIER_RATES[taxYear] ?? SECOND_TIER_RATES[CA_MILEAGE_LATEST_YEAR];

    if (totalKm <= TIER_THRESHOLD_KM) {
      return {
        rate: firstRate,
        unit: 'km',
        tierDescription: `First ${TIER_THRESHOLD_KM} km at $${firstRate}/km`,
      };
    }

    // Blended rate for total distance
    const firstTierAmount = TIER_THRESHOLD_KM * firstRate;
    const secondTierAmount = (totalKm - TIER_THRESHOLD_KM) * secondRate;
    const blendedRate = (firstTierAmount + secondTierAmount) / totalKm;

    return {
      rate: Math.round(blendedRate * 100) / 100,
      unit: 'km',
      tierDescription: `$${firstRate}/km for first ${TIER_THRESHOLD_KM} km, $${secondRate}/km thereafter`,
    };
  },
};
