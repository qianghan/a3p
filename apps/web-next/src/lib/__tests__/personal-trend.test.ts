import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeNetWorthTrend } from '../personal-trend';
import type { AbPersonalAccount, AbPersonalTransaction } from '@naap/database';

// Fixed "now" for deterministic month-end boundaries: July 15, 2026 (local time).
const NOW = new Date(2026, 6, 15);

function makeAccount(overrides: Partial<AbPersonalAccount> = {}): AbPersonalAccount {
  return {
    id: 'acc-default',
    tenantId: 'tenant-1',
    name: 'Test Account',
    type: 'checking',
    balanceCents: 0,
    currency: 'USD',
    isAsset: true,
    plaidAccountId: null,
    archived: false,
    createdAt: new Date(2020, 0, 1),
    updatedAt: new Date(2020, 0, 1),
    ...overrides,
  } as AbPersonalAccount;
}

function makeTxn(overrides: Partial<AbPersonalTransaction> = {}): AbPersonalTransaction {
  return {
    id: 'txn-default',
    tenantId: 'tenant-1',
    accountId: 'acc-default',
    description: 'test txn',
    amountCents: 0,
    date: new Date(2020, 0, 1),
    category: 'uncategorized',
    businessFlag: false,
    notes: null,
    createdAt: new Date(2020, 0, 1),
    ...overrides,
  } as AbPersonalTransaction;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeNetWorthTrend', () => {
  it('aggregates multiple accounts (asset + liability) at the current month-end', () => {
    const accounts = [
      makeAccount({ id: 'a1', isAsset: true, balanceCents: 100_000 }),
      makeAccount({ id: 'a2', isAsset: false, balanceCents: -30_000 }),
    ];
    const result = computeNetWorthTrend(accounts, [], 1);
    expect(result).toHaveLength(1);
    expect(result[0].month).toBe('2026-07');
    // assets 100000 - liabilities |{-30000}| = 100000 - 30000 = 70000
    expect(result[0].netWorthCents).toBe(70_000);
  });

  it('reconstructs a single asset account across boundaries with transactions before and after each month-end', () => {
    const accounts = [makeAccount({ id: 'a1', isAsset: true, balanceCents: 110_000 })];
    const transactions = [
      // Before every boundary in the 3-month window (May/June/July ends) — never subtracted.
      makeTxn({ accountId: 'a1', date: new Date(2026, 3, 10), amountCents: 5_000 }),
      // After May-end, but not after June-end — subtracted only from the May point.
      makeTxn({ accountId: 'a1', date: new Date(2026, 5, 15), amountCents: 3_000 }),
      // After May-end AND June-end, but not after July-end — subtracted from both May and June points.
      makeTxn({ accountId: 'a1', date: new Date(2026, 6, 10), amountCents: 2_000 }),
    ];
    const result = computeNetWorthTrend(accounts, transactions, 3);
    expect(result.map((r) => r.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    // May: 110000 - (3000 + 2000) = 105000
    expect(result[0].netWorthCents).toBe(105_000);
    // June: 110000 - 2000 = 108000
    expect(result[1].netWorthCents).toBe(108_000);
    // July (current month, nothing dated after July-end): 110000
    expect(result[2].netWorthCents).toBe(110_000);
  });

  it('clamps an account created mid-window to $0 for month-ends before its createdAt, not its starting balance', () => {
    const accounts = [
      makeAccount({ id: 'b1', isAsset: true, balanceCents: 20_000, createdAt: new Date(2026, 5, 10) }), // created June 10
    ];
    const result = computeNetWorthTrend(accounts, [], 3);
    expect(result.map((r) => r.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    // May-end (2026-05-31 23:59:59.999) is before createdAt (June 10) -> clamp to 0, NOT 20000.
    expect(result[0].netWorthCents).toBe(0);
    // June-end and July-end are after createdAt -> full reconstructed balance (no txns).
    expect(result[1].netWorthCents).toBe(20_000);
    expect(result[2].netWorthCents).toBe(20_000);
  });

  it('excludes an archived account from every month, not just recent ones', () => {
    const accounts = [
      makeAccount({ id: 'live', isAsset: true, balanceCents: 1_000, createdAt: new Date(2020, 0, 1) }),
      makeAccount({ id: 'gone', isAsset: true, balanceCents: 999_999, archived: true, createdAt: new Date(2020, 0, 1) }),
    ];
    const result = computeNetWorthTrend(accounts, [], 3);
    expect(result.map((r) => r.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    for (const point of result) {
      expect(point.netWorthCents).toBe(1_000);
    }
  });

  it('critical case: a liability account with a transaction crossing a month-end boundary must be reconstructed raw-first, abs-second', () => {
    // Credit-type liability account. Current (as of "now", July 15) balanceCents is -5000.
    const accounts = [
      makeAccount({ id: 'credit-1', type: 'credit', isAsset: false, balanceCents: -5_000, createdAt: new Date(2020, 0, 1) }),
    ];
    // A $200 outflow posted July 10 — after the June-end boundary, before the July-end boundary.
    const transactions = [
      makeTxn({ accountId: 'credit-1', date: new Date(2026, 6, 10), amountCents: -20_000 }),
    ];
    const result = computeNetWorthTrend(accounts, transactions, 2); // June-end, July-end
    expect(result.map((r) => r.month)).toEqual(['2026-06', '2026-07']);

    // --- June-end (the boundary-crossing point) ---
    // CORRECT order (raw reconstruction first, then abs):
    //   raw = balanceCents - txnSumAfter = -5000 - (-20000) = 15000
    //   liability contribution = Math.abs(15000) = 15000
    //   netWorth = assets(0) - liabilities(15000) = -15000
    // WRONG order (abs applied to the current balance BEFORE subtracting the txn) would instead compute:
    //   wrongLiabilityMagnitude = Math.abs(-5000) - (-20000) = 5000 + 20000 = 25000
    //   wrongNetWorth = 0 - 25000 = -25000
    // -15000 !== -25000, so this case genuinely distinguishes the two orders.
    expect(result[0].netWorthCents).toBe(-15_000);
    expect(result[0].netWorthCents).not.toBe(-25_000);

    // --- July-end (no txn after this boundary; raw balance is just the current balance) ---
    // raw = -5000 - 0 = -5000; liability contribution = abs(-5000) = 5000; netWorth = -5000.
    expect(result[1].netWorthCents).toBe(-5_000);
  });

  it('returns points oldest to newest for the default 12-month window', () => {
    const accounts = [makeAccount({ id: 'a1', isAsset: true, balanceCents: 1_000 })];
    const result = computeNetWorthTrend(accounts, []);
    expect(result).toHaveLength(12);
    expect(result[0].month).toBe('2025-08');
    expect(result[11].month).toBe('2026-07');
  });
});
