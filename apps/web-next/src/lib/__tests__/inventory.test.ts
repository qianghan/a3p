// @vitest-environment node
/**
 * PR 5A.3 — inventory engine against the stateful fake ledger.
 *
 * Assertions read computed cents per account and the sub-ledger's qty/value;
 * the 1500 balance must always equal the sum of item values.
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
import { postBill, payBill, voidBill, voidPayment, amendBill } from '../purchases';
import {
  recordOpeningStock, adjustStock, relieveStock, recordPurchaseMovement, resolveAccountByRole,
  accountCodeForRole, reliefValueCents, toUnits, unitsToDecimal, lowStockItems, stockOnHand,
} from '../inventory';

type Fake = ReturnType<typeof createFakeLedgerDb>;
let f: Fake;
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const US = { id: 'cfg', userId: 't1', jurisdiction: 'us', currency: 'USD', accountingBasis: 'accrual', trackInventory: true };

const net = (acct: string) => f.netByAccount()[acct] ?? 0;
const item = (id = 'item-1') => f.state.items.find((i) => i.id === id)!;
const qty = (id = 'item-1') => toUnits(item(id).onHandQty) / 10_000;
/** The invariant: the GL inventory account equals the sub-ledger value. */
const expectTiedOut = () => expect(net('acct-inv')).toBe(f.state.items.reduce((s, i) => s + i.onHandValueCents, 0));

function seedItem(over: Record<string, unknown> = {}) {
  f.state.items.push({
    id: 'item-1', tenantId: 't1', sku: 'W-1', name: 'Widget', unit: 'each', costingMethod: 'wac',
    onHandQty: '0.0000', onHandValueCents: 0, reorderPoint: null, salePriceCents: null,
    isActive: true, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
  });
}

const itemBill = (over: Record<string, unknown> = {}) => ({
  vendorName: 'Acme Supply',
  billDate: D('2026-11-02'),
  dueDate: D('2026-12-02'),
  postingMode: 'at_entry' as const,
  lines: [{ description: '10 widgets', amountCents: 5000, itemId: 'item-1', qty: 10, taxCode: null }],
  ...over,
});

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ ...US });
  seedItem();
});

describe('account roles (5A.1)', () => {
  it('US/CA cogs is 5990; AU/UK cogs is the existing 5000; uk (no own pack yet) follows the US chart', () => {
    expect(accountCodeForRole('cogs', 'us')).toBe('5990');
    expect(accountCodeForRole('cogs', 'ca')).toBe('5990');
    expect(accountCodeForRole('cogs', 'au')).toBe('5000');
    expect(accountCodeForRole('cogs', 'uk')).toBe('5990');
    expect(accountCodeForRole('inventory', 'au')).toBe('1500');
    expect(accountCodeForRole('opening_equity', 'ca')).toBe('3900');
    expect(accountCodeForRole('shrinkage', 'us')).toBe('5995');
  });

  it('resolveAccountByRole reads the tenant jurisdiction', async () => {
    expect((await resolveAccountByRole(f.db, 't1', 'cogs')).id).toBe('acct-cogs');
    f.state.tenantConfigs[0].jurisdiction = 'au';
    expect((await resolveAccountByRole(f.db, 't1', 'cogs')).id).toBe('acct-cogs-5000');
  });
});

describe('qty and relief math', () => {
  it('converts Float quantities via their 4-dp string, never float math', () => {
    expect(toUnits(0.1 + 0.2)).toBe(3000);
    expect(toUnits('12.5')).toBe(125000);
    expect(toUnits('-3.0001')).toBe(-30001);
    expect(unitsToDecimal(125000)).toBe('12.5000');
    expect(() => toUnits('1.23456')).toThrow();
  });

  it('the last unit takes the remainder', () => {
    expect(reliefValueCents(30000, 1000, 10000)).toBe(333);
    expect(reliefValueCents(10000, 334, 10000)).toBe(334);
    expect(reliefValueCents(0, 0, 10000)).toBe(0);
  });
});

describe('purchase via a bill line with itemId (at_entry)', () => {
  it('debits 1500 (not an expense) and adds qty/value', async () => {
    const { bill } = await postBill(f.db, 't1', itemBill());
    const e = f.state.entries.find((x) => x.sourceType === 'bill' && x.sourceId === bill.id)!;
    const lines = f.state.lines.filter((l) => l.entryId === e.id);
    expect(lines.find((l) => l.accountId === 'acct-inv')?.debitCents).toBe(5000);
    expect(lines.some((l) => l.accountId === 'acct-suspense' || l.accountId === 'acct-meals')).toBe(false);
    expect(net('acct-ap')).toBe(-5000);
    expect(qty()).toBe(10);
    expect(item().onHandValueCents).toBe(5000);
    const mv = f.state.movements;
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ type: 'purchase', sourceType: 'bill_line', valueCents: 5000, journalEntryId: e.id });
    expectTiedOut();
  });

  it('voiding the unpaid bill takes the stock back out exactly', async () => {
    const { bill } = await postBill(f.db, 't1', itemBill());
    await voidBill(f.db, 't1', bill.id, { date: D('2026-11-05') });
    expect(qty()).toBe(0);
    expect(item().onHandValueCents).toBe(0);
    expect(net('acct-inv')).toBe(0);
    expect(f.state.movements.map((m) => m.type)).toEqual(['purchase', 'purchase_void']);
  });

  it('refuses to amend a bill with inventory lines (void and re-enter instead)', async () => {
    const { bill } = await postBill(f.db, 't1', itemBill());
    await expect(amendBill(f.db, 't1', bill.id, { description: 'x' })).rejects.toMatchObject({ status: 409, code: 'bill_has_inventory_lines' });
  });

  it('rejects another tenant’s item (404) and a tenant without trackInventory (422)', async () => {
    seedItem({ id: 'item-t2', tenantId: 't2', sku: 'X' });
    await expect(postBill(f.db, 't1', itemBill({ lines: [{ description: 'x', amountCents: 100, itemId: 'item-t2', qty: 1 }] })))
      .rejects.toMatchObject({ status: 404, code: 'item_not_found' });
    f.state.tenantConfigs[0].trackInventory = false;
    await expect(postBill(f.db, 't1', itemBill())).rejects.toMatchObject({ status: 422, code: 'inventory_not_enabled' });
    expect(f.state.movements).toHaveLength(0);
    expect(f.state.entries).toHaveLength(0);
  });
});

describe('purchase via an at_payment bill (cash basis / flag off)', () => {
  it('stock arrives at payment: DR 1500 | CR 1000; voiding the payment reverses it', async () => {
    const { bill } = await postBill(f.db, 't1', itemBill({ postingMode: 'at_payment' }));
    expect(f.state.entries).toHaveLength(0);
    expect(qty()).toBe(0);
    const { payment } = await payBill(f.db, 't1', bill.id, { date: D('2026-11-03') });
    expect(net('acct-inv')).toBe(5000);
    expect(net('acct-cash')).toBe(-5000);
    expect(qty()).toBe(10);
    expectTiedOut();
    await voidPayment(f.db, 't1', payment.id, { date: D('2026-11-04') });
    expect(net('acct-inv')).toBe(0);
    expect(qty()).toBe(0);
    expect(item().onHandValueCents).toBe(0);
  });
});

describe('weighted average cost', () => {
  it('golden: buy 10@$5, buy 10@$7, sell 5 → COGS $30 (value-based relief)', async () => {
    await postBill(f.db, 't1', itemBill());
    await postBill(f.db, 't1', itemBill({ lines: [{ description: '10 more', amountCents: 7000, itemId: 'item-1', qty: 10, taxCode: null }] }));
    expect(item().onHandValueCents).toBe(12000);
    const r = await f.db.$transaction((tx: never) => relieveStock(tx, 't1', { itemId: 'item-1', qty: 5, date: D('2026-11-10'), sourceType: 'stock_sale', sourceId: 'inv-line-1' }));
    expect((r as { valueCents: number }).valueCents).toBe(3000);
    expect(net('acct-cogs')).toBe(3000);
    expect(qty()).toBe(15);
    expect(item().onHandValueCents).toBe(9000);
    expectTiedOut();
  });

  it('value is exactly zero at qty zero (3 units for $10.00, sold one at a time)', async () => {
    await postBill(f.db, 't1', itemBill({ lines: [{ description: '3', amountCents: 1000, itemId: 'item-1', qty: 3, taxCode: null }] }));
    const vals: number[] = [];
    for (const i of [1, 2, 3]) {
      const r = await relieveStock(f.db, 't1', { itemId: 'item-1', qty: 1, date: D('2026-11-10'), sourceType: 'stock_sale', sourceId: `l${i}` });
      vals.push(r.valueCents);
    }
    expect(vals).toEqual([333, 334, 333]); // 667×1÷2 = 333.5 → 334; the last unit takes the rest
    expect(qty()).toBe(0);
    expect(item().onHandValueCents).toBe(0);
    expect(net('acct-inv')).toBe(0);
    expect(net('acct-cogs')).toBe(1000);
  });

  it('negative stock, then a purchase → stock_adjust true-up reconciles 1500', async () => {
    const out = await relieveStock(f.db, 't1', { itemId: 'item-1', qty: 5, date: D('2026-11-01'), sourceType: 'stock_sale', sourceId: 's1' });
    expect(out).toMatchObject({ valueCents: 0, negative: true });
    expect(qty()).toBe(-5);
    await postBill(f.db, 't1', itemBill({ lines: [{ description: '10@7', amountCents: 7000, itemId: 'item-1', qty: 10, taxCode: null }] }));
    // 5 left at $7 = $35; the 5 sold short cost $35 → COGS.
    expect(qty()).toBe(5);
    expect(item().onHandValueCents).toBe(3500);
    expect(net('acct-inv')).toBe(3500);
    expect(net('acct-cogs')).toBe(3500);
    const tu = f.state.movements.find((m) => m.type === 'stock_adjust')!;
    expect(tu).toMatchObject({ valueCents: -3500, sourceType: 'stock_adjust' });
    expect(f.state.entries.some((e) => e.sourceType === 'stock_adjust' && e.sourceId === tu.sourceId)).toBe(true);
    expectTiedOut();
  });
});

describe('opening stock and adjustments', () => {
  it('opening stock balances to 3900', async () => {
    await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') });
    expect(net('acct-inv')).toBe(2000);
    expect(net('acct-ope')).toBe(-2000);
    expect(qty()).toBe(4);
    expectTiedOut();
  });

  it('a shrinkage adjustment relieves at average cost to 5995', async () => {
    await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') });
    await adjustStock(f.db, 't1', { itemId: 'item-1', qty: -1, date: D('2026-11-02'), idempotencyKey: 'adj-1' });
    expect(net('acct-shrink')).toBe(500);
    expect(item().onHandValueCents).toBe(1500);
    expectTiedOut();
  });

  it('closed period → 422 period_closed and nothing is written', async () => {
    f.state.periods.push({ tenantId: 't1', year: 2026, month: 11, status: 'closed' });
    await expect(recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') }))
      .rejects.toMatchObject({ status: 422, code: 'period_closed' });
    await expect(adjustStock(f.db, 't1', { itemId: 'item-1', qty: 1, valueCents: 10, date: D('2026-11-01') }))
      .rejects.toMatchObject({ status: 422, code: 'period_closed' });
    await expect(postBill(f.db, 't1', itemBill())).rejects.toMatchObject({ status: 422 });
    expect(f.state.movements).toHaveLength(0);
    expect(f.state.entries).toHaveLength(0);
    expect(item().onHandValueCents).toBe(0);
  });

  it('replay (and a P2002 on the movement key) → one movement, one entry', async () => {
    const a = await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') });
    const b = await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') });
    expect(b.replayed).toBe(true);
    expect(b.movement.id).toBe(a.movement.id);
    await expect(recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 5, valueCents: 2000, date: D('2026-11-01') }))
      .rejects.toMatchObject({ status: 409 });
    await adjustStock(f.db, 't1', { itemId: 'item-1', qty: -1, date: D('2026-11-02'), idempotencyKey: 'k' });
    await adjustStock(f.db, 't1', { itemId: 'item-1', qty: -1, date: D('2026-11-02'), idempotencyKey: 'k' });
    // Raw unique violation path: the same bill line recorded twice inside one tx.
    await f.db.$transaction(async (tx: never) => {
      await recordPurchaseMovement(tx, 't1', { itemId: 'item-1', billLineId: 'bl-x', qty: 1, valueCents: 100, date: D('2026-11-03'), journalEntryId: null });
      await recordPurchaseMovement(tx, 't1', { itemId: 'item-1', billLineId: 'bl-x', qty: 1, valueCents: 100, date: D('2026-11-03'), journalEntryId: null });
    });
    expect(f.state.movements.filter((m) => m.sourceType === 'stock_opening')).toHaveLength(1);
    expect(f.state.movements.filter((m) => m.sourceId === 'k')).toHaveLength(1);
    expect(f.state.movements.filter((m) => m.sourceId === 'bl-x')).toHaveLength(1);
    expect(f.state.entries.filter((e) => e.sourceType === 'stock_opening')).toHaveLength(1);
    expect(qty()).toBe(4 - 1 + 1);
  });
});

describe('reports', () => {
  it('stock on hand totals and low-stock alert (gated on trackInventory)', async () => {
    f.state.items[0].reorderPoint = '5.0000';
    await recordOpeningStock(f.db, 't1', { itemId: 'item-1', qty: 4, valueCents: 2000, date: D('2026-11-01') });
    const soh = await stockOnHand(f.db, 't1');
    expect(soh.totalValueCents).toBe(2000);
    expect(soh.items[0]).toMatchObject({ onHandQty: 4, avgCostCents: 500, lowStock: true });
    expect((await lowStockItems(f.db, 't1')).map((i) => i.id)).toEqual(['item-1']);
    f.state.tenantConfigs[0].trackInventory = false;
    expect(await lowStockItems(f.db, 't1')).toEqual([]);
  });
});
