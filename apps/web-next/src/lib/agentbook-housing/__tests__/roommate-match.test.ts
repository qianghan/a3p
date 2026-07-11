import { describe, it, expect } from 'vitest';
import { scoreMatch, type RoommateProfileLike } from '../roommate-match';

const base: RoommateProfileLike = {
  tenantId: 'me',
  jurisdiction: 'us',
  area: 'Boston',
  budgetMinCents: 80000,
  budgetMaxCents: 150000,
  moveInMonth: '2026-09',
  lifestyle: ['non-smoker', 'quiet', 'grad-student'],
};

describe('scoreMatch', () => {
  it('scores a strong match high with all the right reasons', () => {
    const other: RoommateProfileLike = {
      tenantId: 'other',
      jurisdiction: 'us',
      area: 'boston', // case-insensitive
      budgetMinCents: 100000,
      budgetMaxCents: 200000,
      moveInMonth: '2026-09',
      lifestyle: ['non-smoker', 'quiet'],
    };
    const r = scoreMatch(base, other);
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(90);
    expect(r!.reasons.some((x) => /Boston/i.test(x))).toBe(true);
    expect(r!.reasons.some((x) => /budget/i.test(x.toLowerCase()))).toBe(true);
    expect(r!.reasons.some((x) => /move-in/i.test(x))).toBe(true);
    expect(r!.reasons.some((x) => /shared preferences/i.test(x))).toBe(true);
  });

  it('drops a fundamentally incompatible profile (different area AND no budget overlap)', () => {
    const other: RoommateProfileLike = {
      tenantId: 'other',
      jurisdiction: 'us',
      area: 'Seattle',
      budgetMinCents: 300000,
      budgetMaxCents: 400000,
      moveInMonth: '2027-01',
      lifestyle: [],
    };
    expect(scoreMatch(base, other)).toBeNull();
  });

  it('keeps a same-area match even when budgets do not overlap', () => {
    const other: RoommateProfileLike = {
      tenantId: 'other',
      jurisdiction: 'us',
      area: 'Boston',
      budgetMinCents: 300000,
      budgetMaxCents: 400000,
      moveInMonth: null,
      lifestyle: [],
    };
    const r = scoreMatch(base, other);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(35); // area only
  });

  it('treats open-ended budgets as overlapping', () => {
    const me: RoommateProfileLike = { ...base, area: 'Toronto', budgetMinCents: null, budgetMaxCents: null };
    const other: RoommateProfileLike = {
      tenantId: 'other', jurisdiction: 'ca', area: 'Vancouver',
      budgetMinCents: 90000, budgetMaxCents: 120000, moveInMonth: null, lifestyle: [],
    };
    // different area but budgets overlap (open-ended) → kept, budget reason not
    // added because *my* range is fully open (no signal to credit).
    const r = scoreMatch(me, other);
    expect(r).not.toBeNull();
  });

  it('caps lifestyle contribution and score at their maxima', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'];
    const me: RoommateProfileLike = { ...base, lifestyle: many };
    const other: RoommateProfileLike = { ...base, tenantId: 'other', lifestyle: many };
    const r = scoreMatch(me, other);
    expect(r!.score).toBeLessThanOrEqual(100);
  });
});
