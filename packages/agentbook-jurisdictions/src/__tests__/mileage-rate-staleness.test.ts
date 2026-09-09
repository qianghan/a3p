import { describe, expect, it } from 'vitest';
import { usMileageRate, usMileageRateForDate, US_MILEAGE_LATEST_PERIOD_FROM } from '../us/mileage-rate.js';
import { auMileageRate, AU_MILEAGE_LATEST_YEAR } from '../au/mileage-rate.js';
import { caMileageRate, CA_MILEAGE_LATEST_YEAR } from '../ca/mileage-rate.js';
import { auFinancialYearOf } from '../au/financial-year.js';

/**
 * THE TEST THAT SHOULD HAVE EXISTED.
 *
 * On the day this was written the mileage tables were behind in all three
 * primary jurisdictions at once, and every suite was green:
 *
 *   US  booking 67c/mile — the 2024 rate — when the IRS allowed 76c
 *   CA  booking 72c/66c when the CRA had moved to 73c/67c
 *   AU  booking 88c/km when the ATO had moved to 91c
 *
 * Nothing failed, because every test asserted the table against a literal
 * copied out of the same table. A rate table cannot be verified against
 * itself; the only thing a test can check without an authority to call is
 * whether the table still claims to cover TODAY.
 *
 * So that is what this does. It goes red when the calendar moves past the
 * newest entry, which is a prompt to go and read the determination — the
 * annual maintenance pass the rate files' comments already refer to, now with
 * something that actually enforces it.
 */

const today = new Date();

describe('the tables still cover today', () => {
  it('US: a rate period has begun for the current date', () => {
    // Grace: the IRS publishes in mid-December for January, so a table that
    // ends at the start of the current calendar year is fine. One that ends
    // before it is a year behind.
    const startOfThisYear = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    expect(
      US_MILEAGE_LATEST_PERIOD_FROM >= startOfThisYear,
      `The newest US mileage period begins ${US_MILEAGE_LATEST_PERIOD_FROM.toISOString().slice(0, 10)}, ` +
      `before ${today.getUTCFullYear()} began. Check IRS Notice for the current standard mileage rate ` +
      'and add a period to us/mileage-rate.ts.',
    ).toBe(true);
  });

  it('US: today resolves without extrapolating past the table', () => {
    expect(usMileageRateForDate(today).extrapolated).toBe(false);
  });

  it('CA: the table holds the current calendar year', () => {
    expect(
      CA_MILEAGE_LATEST_YEAR >= today.getUTCFullYear(),
      `CRA per-km rates stop at ${CA_MILEAGE_LATEST_YEAR} but it is ${today.getUTCFullYear()}. ` +
      'Check the CRA automobile allowance rates and extend ca/mileage-rate.ts.',
    ).toBe(true);
  });

  it('AU: the table holds the current income year', () => {
    // The AU key is the year the financial year ENDS in, so this rolls over
    // on 1 July, not 1 January.
    const currentFy = auFinancialYearOf(today);
    expect(
      AU_MILEAGE_LATEST_YEAR >= currentFy,
      `ATO cents-per-km rates stop at FY${AU_MILEAGE_LATEST_YEAR - 1}-${String(AU_MILEAGE_LATEST_YEAR).slice(2)} ` +
      `but we are in FY${currentFy - 1}-${String(currentFy).slice(2)}. Check the ATO determination and ` +
      'extend au/mileage-rate.ts.',
    ).toBe(true);
  });
});

describe('the current rates are the published ones', () => {
  // Spot-checks against figures published by each authority, written down
  // here so a change to the table has to be a deliberate one. These are the
  // only assertions in the suite NOT derived from the table itself.
  it('US: 70c for 2025, 72.5c and 76c across the 2026 split', () => {
    expect(usMileageRate.getRate(2025, 0).rate).toBeCloseTo(0.70, 5);
    expect(usMileageRateForDate(new Date(Date.UTC(2026, 2, 1))).centsPerMile).toBe(72.5);
    expect(usMileageRateForDate(new Date(Date.UTC(2026, 6, 1))).centsPerMile).toBe(76);
    // The boundary itself: 30 June is still the old rate.
    expect(usMileageRateForDate(new Date(Date.UTC(2026, 5, 30))).centsPerMile).toBe(72.5);
  });

  it('CA: 73c/67c for 2026, 72c/66c for 2025', () => {
    expect(caMileageRate.getRate(2026, 100).rate).toBeCloseTo(0.73, 5);
    expect(caMileageRate.getRate(2025, 100).rate).toBeCloseTo(0.72, 5);
  });

  it('AU: 91c for FY2026-27, and 5,000 km of it is the published A$4,550 cap', () => {
    const r = auMileageRate.getRate(2027, 0);
    expect(r.rate).toBeCloseTo(0.91, 5);
    // The ATO publishes A$4,550 as the maximum claim under this method for
    // 2026-27. That it falls out of rate x cap is a check on both at once.
    expect(Math.round(r.rate * r.maxClaimableUnitsPerYear!)).toBe(4_550);
  });
});
