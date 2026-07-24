import { describe, it, expect } from 'vitest';
import { CORE_PLANS, ADDON_PRICES } from '../index.js';

describe('CORE_PLANS', () => {
  it('has exactly 4 unique plan codes: free, pro, pro_yearly, business', () => {
    expect([...new Set(CORE_PLANS.map((p) => p.code))]).toEqual(['free', 'pro', 'pro_yearly', 'business']);
  });

  it('free is $0, pro is $19/mo, pro_yearly is $182/yr, business is $49/mo', () => {
    expect(CORE_PLANS.find((p) => p.code === 'free')!.priceCents).toBe(0);
    expect(CORE_PLANS.find((p) => p.code === 'pro')!.priceCents).toBe(1900);
    expect(CORE_PLANS.find((p) => p.code === 'pro_yearly')!.priceCents).toBe(18200);
    expect(CORE_PLANS.find((p) => p.code === 'business')!.priceCents).toBe(4900);
  });

  it('pro_yearly is a 20% discount off 12x the monthly price, rounded to a whole dollar', () => {
    const pro = CORE_PLANS.find((p) => p.code === 'pro')!;
    const proYearly = CORE_PLANS.find((p) => p.code === 'pro_yearly')!;
    const fullYearNoDiscount = pro.priceCents * 12;
    const expected = Math.round(fullYearNoDiscount * 0.8 / 100) * 100; // round to whole dollar
    expect(proYearly.priceCents).toBe(expected);
  });

  it('pro and pro_yearly both use interval-appropriate values', () => {
    expect(CORE_PLANS.find((p) => p.code === 'pro')!.interval).toBe('month');
    expect(CORE_PLANS.find((p) => p.code === 'pro_yearly')!.interval).toBe('year');
  });
});

describe('CORE_PLANS region coverage (CA-4)', () => {
  const CODES = ['free', 'pro', 'pro_yearly', 'business'] as const;

  it('every core plan code has both a us and a ca row, at nominal price parity', () => {
    for (const code of CODES) {
      const rows = CORE_PLANS.filter((p) => p.code === code);
      expect(rows).toHaveLength(3); // us, ca, au — see AU-5 below for au
      const us = rows.find((r) => r.region === 'us');
      const ca = rows.find((r) => r.region === 'ca');
      expect(us).toBeDefined();
      expect(ca).toBeDefined();
      expect(us!.currency).toBe('usd');
      expect(ca!.currency).toBe('cad');
      // Nominal parity: same cents figure, matching the established
      // add-on convention (see this file's ADDON_PRICES doc comment).
      expect(ca!.priceCents).toBe(us!.priceCents);
      expect(ca!.name).toBe(us!.name);
      expect(ca!.interval).toBe(us!.interval);
      expect(ca!.sortOrder).toBe(us!.sortOrder);
    }
  });

  it('total CORE_PLANS length is exactly 12 (4 codes x 3 regions)', () => {
    expect(CORE_PLANS).toHaveLength(12);
  });
});

describe('CORE_PLANS region coverage (AU-5)', () => {
  const CODES = ['free', 'pro', 'pro_yearly', 'business'] as const;

  it('every core plan code has an au row in aud, independently uplifted (not nominal parity)', () => {
    for (const code of CODES) {
      const rows = CORE_PLANS.filter((p) => p.code === code);
      const us = rows.find((r) => r.region === 'us')!;
      const au = rows.find((r) => r.region === 'au');
      expect(au).toBeDefined();
      expect(au!.currency).toBe('aud');
      expect(au!.name).toBe(us.name);
      expect(au!.interval).toBe(us.interval);
      expect(au!.sortOrder).toBe(us.sortOrder);
    }
  });

  it('free is $0 AUD (uplift is meaningless at zero)', () => {
    expect(CORE_PLANS.find((p) => p.code === 'free' && p.region === 'au')!.priceCents).toBe(0);
  });

  it('pro is $23 AUD — the same ~1.2x uplift already used for AU add-ons, rounded to the nearest whole dollar (19 * 1.2 = 22.8 -> 23)', () => {
    expect(CORE_PLANS.find((p) => p.code === 'pro' && p.region === 'au')!.priceCents).toBe(2300);
  });

  it('business is $59 AUD', () => {
    const businessAu = CORE_PLANS.find((p) => p.code === 'business' && p.region === 'au')!.priceCents;
    expect(businessAu).toBe(5900);
  });

  it('pro_yearly AUD is 20% off 12x the AUD monthly price, rounded to a whole dollar — the same relationship every other region\'s annual price satisfies, not a re-scaled USD figure', () => {
    const proAu = CORE_PLANS.find((p) => p.code === 'pro' && p.region === 'au')!;
    const proYearlyAu = CORE_PLANS.find((p) => p.code === 'pro_yearly' && p.region === 'au')!;
    const fullYearNoDiscount = proAu.priceCents * 12;
    const expected = Math.round(fullYearNoDiscount * 0.8 / 100) * 100;
    expect(proYearlyAu.priceCents).toBe(expected);
    expect(proYearlyAu.priceCents).toBe(22100);
  });
});

describe('ADDON_PRICES', () => {
  it('has all 4 known add-ons', () => {
    expect(Object.keys(ADDON_PRICES).sort()).toEqual(
      ['personal_insights', 'startup_tax_benefits', 'student_success', 'tax_fast_track'].sort(),
    );
  });

  it('single-tier add-ons each have exactly us/ca/au standard-tier rows at their repriced (2026-07) figures', () => {
    // Repriced off value anchors — regionally adjusted, not nominal parity.
    // personal_insights bills monthly; the other two bill yearly.
    const expected: Record<string, { us: number; ca: number; au: number }> = {
      tax_fast_track: { us: 14900, ca: 19900, au: 22900 },
      student_success: { us: 7900, ca: 9900, au: 11900 },
      personal_insights: { us: 900, ca: 1200, au: 1400 },
    };
    for (const [code, amt] of Object.entries(expected)) {
      const rows = ADDON_PRICES[code];
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.tier === 'standard')).toBe(true);
      expect(rows.find((r) => r.region === 'us')).toMatchObject({ currency: 'usd', priceCents: amt.us });
      expect(rows.find((r) => r.region === 'ca')).toMatchObject({ currency: 'cad', priceCents: amt.ca });
      expect(rows.find((r) => r.region === 'au')).toMatchObject({ currency: 'aud', priceCents: amt.au });
    }
  });

  it('startup_tax_benefits has 3 tiers x 4 regions (us/ca/uk at nominal parity, au independently uplifted)', () => {
    const rows = ADDON_PRICES.startup_tax_benefits;
    expect(rows).toHaveLength(12);
    for (const region of ['us', 'ca', 'uk']) {
      expect(rows.find((r) => r.region === region && r.tier === 'founding_member')).toMatchObject({ priceCents: 9900 });
      expect(rows.find((r) => r.region === region && r.tier === 'standard')).toMatchObject({ priceCents: 24900 });
      expect(rows.find((r) => r.region === region && r.tier === 'scaled')).toMatchObject({ priceCents: 49900 });
    }
    expect(rows.find((r) => r.region === 'au' && r.tier === 'founding_member')).toMatchObject({ currency: 'aud', priceCents: 12900 });
    expect(rows.find((r) => r.region === 'au' && r.tier === 'standard')).toMatchObject({ currency: 'aud', priceCents: 29900 });
    expect(rows.find((r) => r.region === 'au' && r.tier === 'scaled')).toMatchObject({ currency: 'aud', priceCents: 59900 });
  });
});
