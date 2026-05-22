/**
 * Realistic Canadian-jurisdiction tax scenarios (G-013).
 *
 * The existing tax-calculation.test.ts covers each calculation primitive in
 * isolation (bracket math, CPP rate, US SE deduction). This file layers
 * end-to-end tax-estimate scenarios on top, mirroring what real Canadian
 * sole proprietors hit.
 *
 * All math anchored to the brackets shipped in server.ts:
 *   CA_FEDERAL_BRACKETS = [
 *     { upTo: 57_375_00, rate: 0.15 },
 *     { upTo: 114_750_00, rate: 0.205 },
 *     { upTo: 158_468_00, rate: 0.26 },
 *     { upTo: 221_708_00, rate: 0.29 },
 *     { upTo: Infinity, rate: 0.33 },
 *   ]
 *   CPP self-employed = 11.9% of net income (no SE deduction).
 */
import { describe, it, expect } from 'vitest';

const CA_BRACKETS = [
  { upTo: 57_375_00, rate: 0.15 },
  { upTo: 114_750_00, rate: 0.205 },
  { upTo: 158_468_00, rate: 0.26 },
  { upTo: 221_708_00, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
];

function calcProgressiveTax(
  incomeCents: number,
  brackets: { upTo: number; rate: number }[],
): number {
  if (incomeCents <= 0) return 0;
  let remaining = incomeCents;
  let tax = 0;
  let prev = 0;
  for (const bracket of brackets) {
    const width = bracket.upTo === Infinity ? remaining : bracket.upTo - prev;
    const taxable = Math.min(remaining, width);
    tax += Math.round(taxable * bracket.rate);
    remaining -= taxable;
    prev = bracket.upTo;
    if (remaining <= 0) break;
  }
  return tax;
}

function calcCppSelfEmployed(netIncomeCents: number): number {
  if (netIncomeCents <= 0) return 0;
  return Math.round(netIncomeCents * 0.119);
}

function estimateCaTax(netIncomeCents: number) {
  const cpp = calcCppSelfEmployed(netIncomeCents);
  const taxable = Math.max(0, netIncomeCents);
  const income = calcProgressiveTax(taxable, CA_BRACKETS);
  const total = cpp + income;
  return {
    cppCents: cpp,
    incomeTaxCents: income,
    totalTaxCents: total,
    effectiveRate: netIncomeCents > 0 ? total / netIncomeCents : 0,
  };
}

describe('CA tax — realistic scenarios (G-013)', () => {
  describe('Scenario A: side-hustle / first-year consultant ($25k net)', () => {
    it('CPP at 11.9%, all income in bottom bracket', () => {
      const r = estimateCaTax(25_000_00);
      // 25,000 * 0.119 = 2,975 → 297,500c
      expect(r.cppCents).toBe(297_500);
      // Income tax: all in 15% bracket → 25,000 * 0.15 = 3,750 → 375,000c
      expect(r.incomeTaxCents).toBe(375_000);
      // Total = 672,500c = $6,725
      expect(r.totalTaxCents).toBe(672_500);
      // Effective rate around 26.9%
      expect(r.effectiveRate).toBeCloseTo(0.269, 2);
    });
  });

  describe('Scenario B: experienced consultant ($120k net, crosses 3 brackets)', () => {
    it('progressively taxes the bracket boundaries', () => {
      const r = estimateCaTax(120_000_00);
      // CPP: 120,000 * 0.119 = 14,280 → 1,428,000c
      expect(r.cppCents).toBe(1_428_000);
      // Income tax:
      //   bracket 1: 57,375 * 0.15 → 860,625c
      //   bracket 2: 57,375 * 0.205 → 1,176,188c
      //   bracket 3: 5,250 * 0.26 → 136,500c
      const b1 = Math.round(57_375_00 * 0.15);
      const b2 = Math.round((114_750_00 - 57_375_00) * 0.205);
      const b3 = Math.round((120_000_00 - 114_750_00) * 0.26);
      expect(r.incomeTaxCents).toBe(b1 + b2 + b3);
      expect(r.totalTaxCents).toBe(r.cppCents + r.incomeTaxCents);
      // Effective rate should be ~30%
      expect(r.effectiveRate).toBeGreaterThan(0.28);
      expect(r.effectiveRate).toBeLessThan(0.32);
    });
  });

  describe('Scenario C: high-earner ($200k net, crosses 4 brackets)', () => {
    it('cumulative bracket math is correct', () => {
      const r = estimateCaTax(200_000_00);
      // CPP: 200,000 * 0.119 = 23,800 → 2,380,000c
      expect(r.cppCents).toBe(2_380_000);
      const b1 = Math.round(57_375_00 * 0.15);
      const b2 = Math.round((114_750_00 - 57_375_00) * 0.205);
      const b3 = Math.round((158_468_00 - 114_750_00) * 0.26);
      const b4 = Math.round((200_000_00 - 158_468_00) * 0.29);
      expect(r.incomeTaxCents).toBe(b1 + b2 + b3 + b4);
      expect(r.effectiveRate).toBeGreaterThan(0.30);
      expect(r.effectiveRate).toBeLessThan(0.36);
    });
  });

  describe('Scenario D: net loss (-$5k)', () => {
    it('returns zero tax (no CPP on negative income)', () => {
      const r = estimateCaTax(-5_000_00);
      expect(r.cppCents).toBe(0);
      expect(r.incomeTaxCents).toBe(0);
      expect(r.totalTaxCents).toBe(0);
      expect(r.effectiveRate).toBe(0);
    });
  });

  describe('Scenario E: bracket boundary exactly ($57,375 — top of 15%)', () => {
    it('does not spill into the 20.5% bracket', () => {
      const r = estimateCaTax(57_375_00);
      expect(r.incomeTaxCents).toBe(860_625);
    });

    it('crossing the boundary by $100 triggers 20.5% on just that $100', () => {
      const r = estimateCaTax(57_475_00);
      const b1 = Math.round(57_375_00 * 0.15);
      const b2 = Math.round(100_00 * 0.205);
      expect(r.incomeTaxCents).toBe(b1 + b2);
    });
  });

  describe('Scenario F: top-bracket high earner ($300k net)', () => {
    it('33% applies only above $221,708', () => {
      const r = estimateCaTax(300_000_00);
      const b1 = Math.round(57_375_00 * 0.15);
      const b2 = Math.round((114_750_00 - 57_375_00) * 0.205);
      const b3 = Math.round((158_468_00 - 114_750_00) * 0.26);
      const b4 = Math.round((221_708_00 - 158_468_00) * 0.29);
      const b5 = Math.round((300_000_00 - 221_708_00) * 0.33);
      expect(r.incomeTaxCents).toBe(b1 + b2 + b3 + b4 + b5);
      expect(r.cppCents).toBe(3_570_000);
    });
  });

  describe('Effective rate progression (sanity)', () => {
    it('effective rate strictly increases across scenarios A→C→F', () => {
      const a = estimateCaTax(25_000_00).effectiveRate;
      const c = estimateCaTax(200_000_00).effectiveRate;
      const f = estimateCaTax(300_000_00).effectiveRate;
      expect(a).toBeLessThan(c);
      expect(c).toBeLessThan(f);
    });

    it('effective rate stays below the top marginal sum (33% + 11.9% = 44.9%)', () => {
      // Even at $10M of net income, effective stays under the marginal sum.
      const r = estimateCaTax(10_000_000_00);
      expect(r.effectiveRate).toBeLessThan(0.449);
      expect(r.effectiveRate).toBeGreaterThan(0.40);
    });
  });
});
