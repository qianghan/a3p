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

/**
 * The rates above are the ones the CRA publishes for the ten provinces. For
 * travel in the Northwest Territories, Yukon and Nunavut it allows an
 * additional 4c per kilometre, on top of whichever tier applies.
 *
 * This used to be a comment saying it wasn't modelled, which meant a
 * territories-resident sole trader was under-claimed by 4c on every business
 * kilometre. It is a rate, so it belongs in the rate table.
 */
export const CA_TERRITORIES_SUPPLEMENT_PER_KM = 0.04;
/**
 * Codes AND full names — a tenant config row written before region codes were
 * normalized on write can still hold 'Yukon', and uppercasing it does not make
 * it 'YT'. Kept in step with the shell's copy in agentbook-mileage-rates.ts.
 */
const CA_TERRITORIES = new Set([
  'NT', 'YT', 'NU',
  'NORTHWEST TERRITORIES', 'YUKON', 'NUNAVUT',
]);

/**
 * The supplement due for a region, in dollars per km — 0 for the provinces,
 * for an unrecognized code, and for no region at all. Absent information must
 * fall back to the provincial rate: guessing the supplement over-claims, and
 * over-claiming is the direction the CRA penalises.
 *
 * Trimmed and uppercased, and matched against full names as well as codes,
 * because tenant config only started normalizing region codes on write partway
 * through; older rows hold whatever was typed.
 */
function territorialSupplement(region?: string): number {
  const code = (region ?? '').trim().toUpperCase();
  return CA_TERRITORIES.has(code) ? CA_TERRITORIES_SUPPLEMENT_PER_KM : 0;
}

/**
 * Add the supplement in whole cents, not in dollars. `0.67 + 0.04` is
 * 0.7100000000000001 in binary floating point, and that figure would reach the
 * user twice over: interpolated into the tier description below, and as the
 * rate a caller multiplies by. Rates are published in cents, so add in cents.
 */
function plusSupplement(dollarsPerKm: number, supplement: number): number {
  return Math.round(dollarsPerKm * 100 + supplement * 100) / 100;
}

export const caMileageRate: MileageRateProvider = {
  getRate(taxYear: number, totalKm: number, _asOf?: Date, region?: string): MileageRate {
    const supplement = territorialSupplement(region);
    const firstRate = plusSupplement(
      FIRST_TIER_RATES[taxYear] ?? FIRST_TIER_RATES[CA_MILEAGE_LATEST_YEAR], supplement);
    const secondRate = plusSupplement(
      SECOND_TIER_RATES[taxYear] ?? SECOND_TIER_RATES[CA_MILEAGE_LATEST_YEAR], supplement);

    if (totalKm <= TIER_THRESHOLD_KM) {
      return {
        rate: firstRate,
        unit: 'km',
        tierDescription: `First ${TIER_THRESHOLD_KM} km at $${firstRate}/km`,
      };
    }

    // Blended rate for total distance. The supplement is per-km and applies to
    // both tiers, so it survives the blend as a flat +4c.
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
