// @vitest-environment node
/**
 * PR 5B.1 — inventory sales / COGS against the stateful fake ledger.
 * Assertions read computed cents per account; 1500 must always equal the
 * sum of item values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

import { createFakeLedgerDb } from './fake-ledger-db';
import { postBill, payBill, voidPayment } from '../purchases';
import {
  recordOpeningStock, postInvoiceCogs, voidInvoiceCogs, repostInvoiceLineCogs, cogsByPeriod,
  assertItemsOwned, adjustStock, toUnits,
} from '../inventory';

let f: ReturnType<typeof createFakeLedgerDb>;
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const net = (a: string) => f.netByAccount()[a] ?? 0;
const item = () => f.state.items.find((i) => i.id === 'item-1')!;
const qty = () => toUnits(item().onHandQty) / 10_000;
const tied = () => expect(net('acct-inv')).toBe(f.state.items.reduce((s, i) => s + i.onHandValueCents, 0));
const tx = <T>(fn: (t: unknown) => Promise<T>) => f.db.$transaction(fn) as Promise<T>;

beforeEach(async () => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ id: 'cfg', userId: 't1', jurisdiction: 'us', currency: 'USD', accountingBasis: 'accrual', trackInventory: true });
  f.state.items.push({ id: 'item-1', tenantId: 't1', sku: 'W', name: 'Widget', unit: 'each', onHandQty: '0.0000', onHandValueCents: 0, isActive: true, deletedAt: null });
  // 10 @ $5 opening, then 10 @ $7 → 20 units worth $120.
  await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 10, valueCents: 5000, date: D('2026-11-01') });
  await postBill(f.db, 't1', { vendorName: 'Acme', billDate: D('2026-11-02'), dueDate: D('2026-12-02'), postingMode: 'at_entry',
    lines: [{ description: '10 widgets', amountCents: 7000, itemId: 'item-1', qty: 10, taxCode: null }] } as never);
});

const sell = (lines: { id: string; itemId?: string | null; quantity: number }[], date = D('2026-11-10')) =>
  tx((t) => postInvoiceCogs(t, 't1', { invoiceNumber: 'INV-1', date, lines }));

describe('invoice creation posts stock_sale', () => {
  it('DR cogs 5990 | CR 1500 at WAC, keyed by the invoice line id, once', async () => {
    const r = await sell([{ id: 'line-a', itemId: 'item-1', quantity: 5 }, { id: 'line-b', itemId: null, quantity: 3 }]);
    expect(r).toEqual([{ lineId: 'line-a', valueCents: 3000, negative: false }]);
    expect(net('acct-cogs')).toBe(3000);
    expect(net('acct-inv')).toBe(9000);
    expect(qty()).toBe(15);
    const e = f.state.entries.filter((x) => x.sourceType === 'stock_sale');
    expect(e.map((x) => x.sourceId)).toEqual(['line-a']);
    await sell([{ id: 'line-a', itemId: 'item-1', quantity: 5 }]); // replay
    expect(net('acct-cogs')).toBe(3000);
    expect(f.state.entries.filter((x) => x.sourceType === 'stock_sale')).toHaveLength(1);
    tied();
  });

  it('Float quantities are converted exactly (0.1 + 0.2 units)', async () => {
    await sell([{ id: 'l', itemId: 'item-1', quantity: 0.1 + 0.2 }]);
    expect(qty()).toBe(19.7);
    expect(net('acct-cogs')).toBe(Math.round((12000 * 3000) / 200000)); // 180
    tied();
  });

  it('does nothing when trackInventory is off', async () => {
    f.state.tenantConfigs[0].trackInventory = false;
    expect(await sell([{ id: 'l', itemId: 'item-1', quantity: 5 }])).toEqual([]);
    expect(net('acct-cogs')).toBe(0);
    expect(qty()).toBe(20);
  });

  it('AU posts COGS to its existing 5000 account (P&L per jurisdiction)', async () => {
    f.state.tenantConfigs[0].jurisdiction = 'au';
    await sell([{ id: 'l', itemId: 'item-1', quantity: 20 }]);
    const pl = f.netByAccountInRange(D('2026-11-01'), D('2026-12-01'));
    expect(pl['acct-cogs-5000']).toBe(12000);
    expect(pl['acct-cogs']).toBeUndefined();
    expect(item().onHandValueCents).toBe(0); // last unit took the remainder
    tied();
  });
});

describe('invoice void posts stock_sale_void', () => {
  it('returns exactly the value taken out; accounts back to pre-sale', async () => {
    await sell([{ id: 'line-a', itemId: 'item-1', quantity: 7 }]);
    expect(net('acct-cogs')).toBe(4200);
    await tx((t) => voidInvoiceCogs(t, 't1', { invoiceNumber: 'INV-1', date: D('2026-11-11'), lineIds: ['line-a', 'line-x'] }));
    expect(net('acct-cogs')).toBe(0);
    expect(net('acct-inv')).toBe(12000);
    expect(qty()).toBe(20);
    expect(f.state.entries.filter((e) => e.sourceType === 'stock_sale_void').map((e) => e.sourceId)).toEqual(['line-a']);
    await tx((t) => voidInvoiceCogs(t, 't1', { invoiceNumber: 'INV-1', date: D('2026-11-11'), lineIds: ['line-a'] }));
    expect(net('acct-inv')).toBe(12000);
    tied();
  });
});

describe('editing item qty reverses and reposts', () => {
  it('5 → 8: net COGS is the 8-unit relief, and a later void restores everything', async () => {
    await sell([{ id: 'line-a', itemId: 'item-1', quantity: 5 }]);
    await tx((t) => repostInvoiceLineCogs(t, 't1', { invoiceNumber: 'INV-1', date: D('2026-11-12'), line: { id: 'line-a', itemId: 'item-1', quantity: 8 }, rev: 1 }));
    expect(net('acct-cogs')).toBe(4800);
    expect(qty()).toBe(12);
    expect(f.state.entries.filter((e) => e.sourceType === 'stock_sale_edit_reverse').map((e) => e.sourceId)).toEqual(['line-a:1']);
    expect(f.state.entries.filter((e) => e.sourceType === 'stock_sale').map((e) => e.sourceId)).toEqual(['line-a', 'line-a:1']);
    await tx((t) => voidInvoiceCogs(t, 't1', { invoiceNumber: 'INV-1', date: D('2026-11-13'), lineIds: ['line-a'] }));
    expect(net('acct-cogs')).toBe(0);
    expect(qty()).toBe(20);
    tied();
  });
});

describe('negative stock', () => {
  it('selling 25 of 20 relieves all value, flags negative, next purchase trues up', async () => {
    const [r] = await sell([{ id: 'l', itemId: 'item-1', quantity: 25 }]);
    expect(r).toEqual({ lineId: 'l', valueCents: 12000, negative: true });
    expect(qty()).toBe(-5);
    expect(item().onHandValueCents).toBe(0);
    await postBill(f.db, 't1', { vendorName: 'Acme', billDate: D('2026-11-20'), dueDate: D('2026-12-20'), postingMode: 'at_entry',
      lines: [{ description: '10 widgets', amountCents: 8000, itemId: 'item-1', qty: 10, taxCode: null }] } as never);
    expect(qty()).toBe(5);
    expect(item().onHandValueCents).toBe(4000); // 5 × $8
    expect(net('acct-cogs')).toBe(12000 + 4000); // true-up: the 5 oversold units at $8
    tied();
  });
});

describe('5A fixes found by the journal property test', () => {
  it('an at_payment item bill paid, payment voided, paid again: stock comes in twice-minus-once, 1500 ties out', async () => {
    const { bill } = await postBill(f.db, 't1', { vendorName: 'Acme', billDate: D('2026-11-03'), dueDate: D('2026-12-03'), postingMode: 'at_payment',
      lines: [{ description: '5 widgets', amountCents: 2500, itemId: 'item-1', qty: 5, taxCode: null }] } as never);
    const billId = bill.id as string;
    await payBill(f.db, 't1', billId, {});
    expect(qty()).toBe(25);
    const pay = f.state.billPayments.find((p) => p.billId === billId && !p.voidedAt)!;
    await voidPayment(f.db, 't1', pay.id);
    expect(qty()).toBe(20);
    await payBill(f.db, 't1', billId, {});
    expect(qty()).toBe(25);
    expect(item().onHandValueCents).toBe(12000 + 2500);
    tied();
  });

  it('a relief never moves a negative value (sub-ledger and 1500 move together)', async () => {
    item().onHandValueCents = -500; // a state reachable via voids of already-sold purchases
    f.state.lines.push({ id: 'jl-x', entryId: 'je-x', accountId: 'acct-inv', debitCents: 0, creditCents: 12500 });
    await sell([{ id: 'l', itemId: 'item-1', quantity: 1 }]);
    expect(item().onHandValueCents).toBe(-500);
    tied();
  });
});

describe('reports and guards', () => {
  it('COGS by period nets sales and voids per month/quarter', async () => {
    await sell([{ id: 'a', itemId: 'item-1', quantity: 5 }], D('2026-11-10'));
    await sell([{ id: 'b', itemId: 'item-1', quantity: 5 }], D('2026-12-10'));
    await tx((t) => voidInvoiceCogs(t, 't1', { invoiceNumber: 'INV-2', date: D('2026-12-15'), lineIds: ['b'] }));
    const m = await cogsByPeriod(f.db, 't1', { from: D('2026-10-01'), to: D('2027-01-01'), granularity: 'month' });
    expect(m).toEqual({ periods: [{ period: '2026-11', cogsCents: 3000 }, { period: '2026-12', cogsCents: 0 }], totalCents: 3000 });
    const q = await cogsByPeriod(f.db, 't1', { from: D('2026-10-01'), to: D('2027-01-01'), granularity: 'quarter' });
    expect(q.periods).toEqual([{ period: '2026-Q4', cogsCents: 3000 }]);
  });

  it('cross-tenant item ids are 404', async () => {
    await expect(assertItemsOwned(f.db, 't2', ['item-1'])).rejects.toMatchObject({ status: 404 });
    await expect(assertItemsOwned(f.db, 't1', ['item-1'])).resolves.toBeUndefined();
  });

  it('shrinkage write-off with a reason books 5995', async () => {
    await adjustStock(f.db, 't1', { itemId: 'item-1', qty: -2, date: D('2026-11-15'), reason: 'damaged' });
    expect(net('acct-shrink')).toBe(1200);
    expect(f.state.entries.find((e) => e.sourceType === 'stock_adjust')!.memo).toContain('damaged');
    tied();
  });
});
