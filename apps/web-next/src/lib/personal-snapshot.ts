/** Pure personal-finance snapshot math, shared by the route and its tests. */

export interface SnapshotAccount { balanceCents: number; isAsset: boolean }
export interface SnapshotTxn { amountCents: number; category: string; businessFlag: boolean }

export interface SnapshotResult {
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  month: {
    incomeCents: number;
    spendingCents: number;
    savingsRate: number;
    businessFlaggedCents: number;
    spendByCategory: { category: string; amountCents: number }[];
  };
}

export function computeSnapshot(accounts: SnapshotAccount[], monthTxns: SnapshotTxn[]): SnapshotResult {
  let assetsCents = 0;
  let liabilitiesCents = 0;
  for (const a of accounts) {
    if (a.isAsset) assetsCents += a.balanceCents;
    else liabilitiesCents += Math.abs(a.balanceCents);
  }
  const netWorthCents = assetsCents - liabilitiesCents;

  let incomeCents = 0;
  let spendingCents = 0;
  let businessFlaggedCents = 0;
  const spendByCategory = new Map<string, number>();
  for (const t of monthTxns) {
    if (t.amountCents >= 0) {
      incomeCents += t.amountCents;
    } else {
      const out = Math.abs(t.amountCents);
      spendingCents += out;
      spendByCategory.set(t.category, (spendByCategory.get(t.category) || 0) + out);
      if (t.businessFlag) businessFlaggedCents += out;
    }
  }

  const savingsRate = incomeCents > 0
    ? Math.round(((incomeCents - spendingCents) / incomeCents) * 100)
    : 0;

  const spendByCategoryArr = Array.from(spendByCategory.entries())
    .map(([category, amountCents]) => ({ category, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);

  return {
    netWorthCents,
    assetsCents,
    liabilitiesCents,
    month: { incomeCents, spendingCents, savingsRate, businessFlaggedCents, spendByCategory: spendByCategoryArr },
  };
}
