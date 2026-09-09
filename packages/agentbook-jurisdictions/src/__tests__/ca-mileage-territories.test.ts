import { describe, expect, it } from 'vitest';
import { caMileageRate, CA_TERRITORIES_SUPPLEMENT_PER_KM } from '../ca/mileage-rate.js';
import { statutoryFactLines } from '../statutory-facts.js';

/**
 * The CRA's territorial supplement.
 *
 * The automobile allowance rates the CRA publishes are the rates for the ten
 * provinces. For travel in the Northwest Territories, Yukon and Nunavut it
 * allows an additional 4c per kilometre, on top of whichever tier applies.
 *
 * `getRate` had no region, so it returned the provincial rate to everybody and
 * a territories-resident sole trader was under-claimed by 4c on every business
 * kilometre they drove. A file comment said so; nothing computed it.
 *
 * The supplement is per-kilometre and applies to both tiers, so on the blended
 * figure this provider returns it lands as a flat +4c however far past the
 * 5,000 km break the year has run — which is what the arithmetic below checks.
 */

const TERRITORIES = ['NT', 'YT', 'NU'] as const;
const PROVINCES = ['AB', 'BC', 'SK', 'MB', 'ON', 'QC', 'NB', 'NS', 'NL', 'PE'] as const;

describe('the territorial 4c/km supplement is applied', () => {
  it('exports the supplement as a number, not a comment', () => {
    expect(CA_TERRITORIES_SUPPLEMENT_PER_KM).toBeCloseTo(0.04, 5);
  });

  it.each(TERRITORIES)('%s gets 77c in the first tier for 2026, not 73c', (region) => {
    const r = caMileageRate.getRate(2026, 100, undefined, region);
    expect(r.rate).toBeCloseTo(0.77, 5);
    // The provincial figure is what the bug returned.
    expect(r.rate).not.toBeCloseTo(0.73, 5);
    expect(r.unit).toBe('km');
  });

  it.each(TERRITORIES)('%s carries the supplement past the 5,000 km break', (region) => {
    // 10,000 km in 2026: (5,000 x 77c + 5,000 x 71c) / 10,000 = 74c blended.
    // Base is (5,000 x 73c + 5,000 x 67c) / 10,000 = 70c.
    const supplemented = caMileageRate.getRate(2026, 10_000, undefined, region);
    const base = caMileageRate.getRate(2026, 10_000);
    expect(supplemented.rate).toBeCloseTo(0.74, 5);
    expect(base.rate).toBeCloseTo(0.70, 5);
    expect(supplemented.rate - base.rate).toBeCloseTo(0.04, 5);
  });

  it('applies to an earlier year against that year\'s own tiers', () => {
    // 2025 provincial tiers are 72c/66c, so the territories see 76c/70c.
    expect(caMileageRate.getRate(2025, 100, undefined, 'NU').rate).toBeCloseTo(0.76, 5);
    expect(caMileageRate.getRate(2025, 10_000, undefined, 'NU').rate).toBeCloseTo(0.73, 5);
  });

  it('names the supplemented rates in the tier description', () => {
    // The description is the memo line and the audit trail. Quoting the
    // provincial rate beside a supplemented amount reads as an arithmetic bug.
    const first = caMileageRate.getRate(2026, 100, undefined, 'YT');
    expect(first.tierDescription).toContain('0.77');
    expect(first.tierDescription).not.toContain('0.73');

    const second = caMileageRate.getRate(2026, 10_000, undefined, 'YT');
    expect(second.tierDescription).toContain('0.77');
    expect(second.tierDescription).toContain('0.71');
  });

  it('accepts a region that was stored un-normalized', () => {
    // Config normalizes to an uppercase code on write, but rows predate that.
    expect(caMileageRate.getRate(2026, 100, undefined, ' nt ').rate).toBeCloseTo(0.77, 5);
  });
});

describe('every other province is left exactly as it was', () => {
  it.each(PROVINCES)('%s still gets the published provincial tiers', (region) => {
    expect(caMileageRate.getRate(2026, 100, undefined, region).rate).toBeCloseTo(0.73, 5);
    expect(caMileageRate.getRate(2026, 10_000, undefined, region).rate).toBeCloseTo(0.70, 5);
  });

  it.each([undefined, '', 'ZZ'] as const)('a region of %o falls back to the provincial rate', (region) => {
    // No region recorded is the common case and must not silently over-claim.
    expect(caMileageRate.getRate(2026, 100, undefined, region).rate).toBeCloseTo(0.73, 5);
  });
});

describe('the grounding facts quote the rate the app will book', () => {
  it('tells a Yukon tenant 77 cents, not 73', () => {
    // These lines are the statutory context handed to the model. Quoting the
    // provincial rate to a territories tenant means chat says "73 cents/km"
    // about a trip the app books at 77 — the user's two answers disagree and
    // neither is labelled as the wrong one.
    const yt = statutoryFactLines('ca', 'YT', 2026).lines.join('\n');
    expect(yt).toMatch(/Mileage rate: 77 cents per km/);
    expect(yt).not.toMatch(/Mileage rate: 73 cents per km/);
  });

  it('still tells an Ontario tenant 73 cents', () => {
    const on = statutoryFactLines('ca', 'ON', 2026).lines.join('\n');
    expect(on).toMatch(/Mileage rate: 73 cents per km/);
  });

  it('falls back to the provincial rate with no region recorded', () => {
    for (const region of [undefined, null, ''] as const) {
      expect(statutoryFactLines('ca', region, 2026).lines.join('\n'))
        .toMatch(/Mileage rate: 73 cents per km/);
    }
  });

  it('does not supplement an Australian NT tenant', () => {
    // 'NT' is the Northern Territory here. The rate must be the flat ATO one.
    const au = statutoryFactLines('au', 'NT', 2027).lines.join('\n');
    const auNoRegion = statutoryFactLines('au', '', 2027).lines.join('\n');
    const line = (t: string) => t.split('\n').find((l) => l.startsWith('Mileage rate:'));
    expect(line(au)).toBe(line(auNoRegion));
  });
});
