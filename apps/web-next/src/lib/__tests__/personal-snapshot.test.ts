import { describe, it, expect } from 'vitest';
import { computeSnapshot } from '../personal-snapshot';

describe('personal finance snapshot', () => {
  it('net worth = assets minus liabilities', () => {
    const r = computeSnapshot(
      [
        { balanceCents: 10_000_00, isAsset: true },  // checking
        { balanceCents: 50_000_00, isAsset: true },  // investment
        { balanceCents: 8_000_00, isAsset: false },  // credit card debt
      ],
      [],
    );
    expect(r.assetsCents).toBe(60_000_00);
    expect(r.liabilitiesCents).toBe(8_000_00);
    expect(r.netWorthCents).toBe(52_000_00);
  });

  it('splits income (inflow) from spending (outflow) and computes savings rate', () => {
    const r = computeSnapshot([], [
      { amountCents: 5_000_00, category: 'salary', businessFlag: false },
      { amountCents: -1_500_00, category: 'rent', businessFlag: false },
      { amountCents: -500_00, category: 'groceries', businessFlag: false },
    ]);
    expect(r.month.incomeCents).toBe(5_000_00);
    expect(r.month.spendingCents).toBe(2_000_00);
    // (5000 - 2000) / 5000 = 60%
    expect(r.month.savingsRate).toBe(60);
  });

  it('tallies business-flagged spend separately', () => {
    const r = computeSnapshot([], [
      { amountCents: -200_00, category: 'software', businessFlag: true },
      { amountCents: -50_00, category: 'coffee', businessFlag: false },
    ]);
    expect(r.month.businessFlaggedCents).toBe(200_00);
    expect(r.month.spendingCents).toBe(250_00);
  });

  it('sorts spend-by-category descending', () => {
    const r = computeSnapshot([], [
      { amountCents: -100_00, category: 'a', businessFlag: false },
      { amountCents: -300_00, category: 'b', businessFlag: false },
      { amountCents: -200_00, category: 'c', businessFlag: false },
    ]);
    expect(r.month.spendByCategory.map((s) => s.category)).toEqual(['b', 'c', 'a']);
  });

  it('savings rate is 0 when there is no income', () => {
    const r = computeSnapshot([], [{ amountCents: -100_00, category: 'x', businessFlag: false }]);
    expect(r.month.savingsRate).toBe(0);
  });
});
