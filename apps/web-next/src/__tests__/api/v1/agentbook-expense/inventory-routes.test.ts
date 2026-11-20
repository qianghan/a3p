// @vitest-environment node
/**
 * PR 5A.4 — the inventory route handlers (real handlers, in-memory DB).
 * Tenant scoping, 409 duplicate SKU, soft delete, opening stock to 3900 and
 * an at_payment bill line with itemId bringing stock in at payment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => {
  const { memDb } = await import('@/__tests__/helpers/mem-db');
  return { prisma: new Proxy(memDb, { get: (t, p) => (p === 'featureFlag' ? { findUnique: async () => null } : (t as never)[p]) }) };
});
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET as LIST, POST as CREATE } from '@/app/api/v1/agentbook-expense/inventory/items/route';
import { GET as ONE, PATCH, DELETE } from '@/app/api/v1/agentbook-expense/inventory/items/[id]/route';
import { POST as OPENING } from '@/app/api/v1/agentbook-expense/inventory/items/[id]/opening/route';
import { POST as ADJUST } from '@/app/api/v1/agentbook-expense/inventory/items/[id]/adjust/route';
import { GET as LOW } from '@/app/api/v1/agentbook-expense/inventory/low-stock/route';
import { POST as CREATE_BILL } from '@/app/api/v1/agentbook-expense/bills/route';
import { POST as BILL_ACTION } from '@/app/api/v1/agentbook-expense/bills/[id]/route';

const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-inv', tenantId: 't1', code: '1500', name: 'Inventory', accountType: 'asset', isActive: true },
  { id: 'acc-ap', tenantId: 't1', code: '2000', name: 'AP', accountType: 'liability', isActive: true },
  { id: 'acc-ope', tenantId: 't1', code: '3900', name: 'Opening Balance Equity', accountType: 'equity', isActive: true },
  { id: 'acc-cogs', tenantId: 't1', code: '5990', name: 'COGS', accountType: 'expense', isActive: true },
  { id: 'acc-shrink', tenantId: 't1', code: '5995', name: 'Shrinkage', accountType: 'expense', isActive: true },
  { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
];
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const net = (acct: string) => memDb.table('abJournalLine').rows.filter((l) => l.accountId === acct)
  .reduce((s, l) => s + (l.debitCents as number) - (l.creditCents as number), 0);
function seed(trackInventory = true) {
  memDb.reset(
    {
      abAccount: ACCOUNTS, abBill: [], abBillLine: [], abBillPayment: [], abFiscalPeriod: [], abInventoryItem: [], abStockMovement: [],
      abTenantConfig: [{ userId: 't1', currency: 'USD', jurisdiction: 'us', accountingBasis: 'cash', trackInventory }, { userId: 't2', currency: 'USD', jurisdiction: 'us', trackInventory: true }],
    },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']], abInventoryItem: [['tenantId', 'sku']], abStockMovement: [['tenantId', 'sourceType', 'sourceId']], abBill: [['id']], abBillPayment: [['id']] } },
  );
}
async function call(h: (r: never, c: never) => Promise<Response>, path: string, init: Row = {}, id?: string, tenant = 't1') {
  const res = await h(tenantReq(path, tenant, init as never) as never, (id ? ctx(id) : undefined) as never);
  return { status: res.status, body: await json<{ success: boolean; data: Row & Row[]; code?: string; summary?: Row }>(res) };
}
const create = (body: Row, tenant = 't1') => call(CREATE as never, '/api/v1/agentbook-expense/inventory/items', { method: 'POST', body }, undefined, tenant);

beforeEach(() => seed());

describe('items CRUD', () => {
  it('requires trackInventory to create (422), gated on the flag', async () => {
    seed(false);
    const r = await create({ name: 'Widget', sku: 'W-1' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('inventory_not_enabled');
  });

  it('creates, rejects a duplicate SKU with 409, and edits', async () => {
    const a = await create({ name: 'Widget', sku: 'W-1', reorderPoint: 5 });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ name: 'Widget', sku: 'W-1', onHandQty: 0, onHandValueCents: 0, reorderPoint: 5 });
    const dup = await create({ name: 'Other', sku: 'W-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate_sku');
    const p = await call(PATCH as never, `/x`, { method: 'PATCH', body: { name: 'Blue widget' } }, a.body.data.id);
    expect(p.body.data.name).toBe('Blue widget');
  });

  it('another tenant’s item is a 404 everywhere', async () => {
    const a = await create({ name: 'Theirs', sku: 'T' }, 't2');
    const id = a.body.data.id;
    expect((await call(ONE as never, '/x', {}, id)).status).toBe(404);
    expect((await call(PATCH as never, '/x', { method: 'PATCH', body: { name: 'x' } }, id)).status).toBe(404);
    expect((await call(DELETE as never, '/x', { method: 'DELETE' }, id)).status).toBe(404);
    expect((await call(OPENING as never, '/x', { method: 'POST', body: { qty: 1, valueCents: 100 } }, id)).status).toBe(404);
  });

  it('DELETE is a soft delete: the row and its movements stay', async () => {
    const a = await create({ name: 'Widget', sku: 'W-1' });
    await call(OPENING as never, '/x', { method: 'POST', body: { qty: 2, valueCents: 1000, date: '2026-11-01' } }, a.body.data.id);
    const d = await call(DELETE as never, '/x', { method: 'DELETE' }, a.body.data.id);
    expect(d.status).toBe(200);
    const row = memDb.table('abInventoryItem').rows[0];
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(memDb.table('abStockMovement').rows).toHaveLength(1);
    expect((await call(LIST as never, '/x')).body.data).toHaveLength(0);
    expect((await call(ONE as never, '/x', {}, a.body.data.id)).status).toBe(404);
  });
});

describe('postings through the routes', () => {
  it('opening stock: DR 1500 | CR 3900; adjust −1 → 5995 at average cost; low-stock alert', async () => {
    const a = await create({ name: 'Widget', sku: 'W-1', reorderPoint: 4 });
    const id = a.body.data.id;
    const o = await call(OPENING as never, '/x', { method: 'POST', body: { qty: 4, valueCents: 2000, date: '2026-11-01' } }, id);
    expect(o.status).toBe(201);
    expect(net('acc-inv')).toBe(2000);
    expect(net('acc-ope')).toBe(-2000);
    const adj = await call(ADJUST as never, '/x', { method: 'POST', body: { qty: -1, date: '2026-11-02', idempotencyKey: 'a1' } }, id);
    expect(adj.status).toBe(201);
    const again = await call(ADJUST as never, '/x', { method: 'POST', body: { qty: -1, date: '2026-11-02', idempotencyKey: 'a1' } }, id);
    expect(again.status).toBe(200);
    expect(net('acc-shrink')).toBe(500);
    expect(net('acc-inv')).toBe(1500);
    const one = await call(ONE as never, '/x', {}, id);
    expect(one.body.data).toMatchObject({ onHandQty: 3, onHandValueCents: 1500, avgCostCents: 500, lowStock: true });
    expect(one.body.data.movements).toHaveLength(2);
    expect((await call(LOW as never, '/x')).body.data.map((i: Row) => i.id)).toEqual([id]);
  });

  it('an at_payment bill with itemId brings stock in at payment (DR 1500 | CR 1000)', async () => {
    const a = await create({ name: 'Widget', sku: 'W-1' });
    const id = a.body.data.id;
    const b = await call(CREATE_BILL as never, '/api/v1/agentbook-expense/bills', { method: 'POST', body: { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-01', itemId: id, qty: 10 } });
    expect(b.status).toBe(201);
    expect(memDb.table('abStockMovement').rows).toHaveLength(0);
    const pay = await call(BILL_ACTION as never, `/api/v1/agentbook-expense/bills/${b.body.data.id}?action=pay`, { method: 'POST', body: { paidDate: '2026-11-15T00:00:00Z' } }, b.body.data.id);
    expect(pay.status).toBe(200);
    expect(net('acc-inv')).toBe(5000);
    expect(net('acc-cash')).toBe(-5000);
    const one = await call(ONE as never, '/x', {}, id);
    expect(one.body.data).toMatchObject({ onHandQty: 10, onHandValueCents: 5000 });
  });

  it('a bill with another tenant’s itemId is refused (404) and nothing is created', async () => {
    const theirs = await create({ name: 'Theirs', sku: 'T' }, 't2');
    const b = await call(CREATE_BILL as never, '/api/v1/agentbook-expense/bills', { method: 'POST', body: { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-01', itemId: theirs.body.data.id } });
    expect(b.status).toBe(404);
    expect(memDb.table('abBill').rows).toHaveLength(0);
  });
});
