import { describe, it, expect } from 'vitest';
import { sumOpenBills } from '../balance-sheet';

describe('balance-sheet · sumOpenBills (accrual A/P)', () => {
  it('returns 0 for no bills', () => {
    expect(sumOpenBills([])).toBe(0);
  });

  it('sums only bills with status "open"', () => {
    const total = sumOpenBills([
      { status: 'open', amountCents: 10_000 },
      { status: 'open', amountCents: 5_000 },
      { status: 'paid', amountCents: 9_999 },
      { status: 'cancelled', amountCents: 4_444 },
    ]);
    expect(total).toBe(15_000);
  });

  it('ignores paid and cancelled bills entirely', () => {
    expect(
      sumOpenBills([
        { status: 'paid', amountCents: 100 },
        { status: 'cancelled', amountCents: 200 },
      ]),
    ).toBe(0);
  });

  it('treats a missing amount as zero (defensive)', () => {
    expect(
      sumOpenBills([
        { status: 'open', amountCents: undefined as unknown as number },
        { status: 'open', amountCents: 700 },
      ]),
    ).toBe(700);
  });
});
