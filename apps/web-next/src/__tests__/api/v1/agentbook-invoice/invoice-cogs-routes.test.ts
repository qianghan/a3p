// @vitest-environment node
/**
 * PR 5B — the invoice route handlers post COGS (real handlers, in-memory DB).
 * create → stock_sale per item line; void → stock_sale_void; PATCH line qty →
 * revenue and COGS reversed and reposted. Cents per account are asserted.
 * mem-db has no nested writes, so a thin adapter splits `lines: { create }`
 * and attaches `include: { lines, payments }` the way Prisma would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => {
  const { memDb } = await import('@/__tests__/helpers/mem-db');
  type R = Record<string, unknown>;
  const t = (m: string) => memDb.table(m) as unknown as Record<string, (a: R) => Promise<R>>;
  const adapter: Record<string, unknown> = {
    featureFlag: { findUnique: async () => null },
    abJournalEntry: new Proxy({}, { get: (_o, p) => p === 'create'
      ? async ({ data }: { data: R }) => {
        const { lines, ...rest } = data as R & { lines?: { create: R[] } };
        const e = await t('abJournalEntry').create({ data: rest });
        for (const l of lines?.create ?? []) await t('abJournalLine').create({ data: { ...l, entryId: e.id } });
        return e;
      }
      : (t('abJournalEntry') as never)[p] }),
    abInvoice: new Proxy({}, { get: (_o, p) => {
      const withRel = async (inv: R | null) => inv && {
        ...inv,
        lines: await t('abInvoiceLine').findMany({ where: { invoiceId: inv.id } } as never),
        payments: await t('abPayment').findMany({ where: { invoiceId: inv.id } } as never),
      };
      if (p === 'create') return async ({ data }: { data: R }) => {
        const { lines, ...rest } = data as R & { lines?: { create: R[] } };
        const inv = await t('abInvoice').create({ data: rest });
        for (const l of lines?.create ?? []) await t('abInvoiceLine').create({ data: { ...l, invoiceId: inv.id } });
        return withRel(inv);
      };
      if (p === 'findFirst') return async (a: R) => withRel(await t('abInvoice').findFirst(a));
      if (p === 'update') return async (a: R) => withRel(await t('abInvoice').update(a));
      return (t('abInvoice') as never)[p];
    } }),
  };
  const proxy: unknown = new Proxy(memDb, { get: (tg, p) => (p === '$transaction'
    ? async (fn: (tx: unknown) => Promise<unknown>) => fn(proxy)
    : p in adapter ? adapter[p as string] : (tg as never)[p]) });
  return { prisma: proxy };
});
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'api', inferActor: async () => 'user' }));
vi.mock('@/lib/agentbook-idempotency', () => ({
  withHttpIdempotency: async (req: Request, o: { handler: (b: string) => Promise<{ status: number; body: unknown }> }) => {
    const { NextResponse } = await import('next/server');
    const r = await o.handler(await req.text());
    return NextResponse.json(r.body, { status: r.status });
  },
}));
vi.mock('@/lib/agentbook-invoice-tax', () => ({
  computeInvoiceTax: vi.fn(async () => ({ taxRate: 0, taxCents: 0, components: [] })),
}));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { POST as CREATE } from '@/app/api/v1/agentbook-invoice/invoices/route';
import { PATCH } from '@/app/api/v1/agentbook-invoice/invoices/[id]/route';
import { POST as VOID } from '@/app/api/v1/agentbook-invoice/invoices/[id]/void/route';
import { GET as COGS } from '@/app/api/v1/agentbook-expense/inventory/cogs/route';

const ACCOUNTS: Row[] = [
  { id: 'acc-ar', tenantId: 't1', code: '1100', name: 'AR', accountType: 'asset', isActive: true },
  { id: 'acc-inv', tenantId: 't1', code: '1500', name: 'Inventory', accountType: 'asset', isActive: true },
  { id: 'acc-rev', tenantId: 't1', code: '4000', name: 'Revenue', accountType: 'revenue', isActive: true },
  { id: 'acc-cogs', tenantId: 't1', code: '5990', name: 'COGS', accountType: 'expense', isActive: true },
  { id: 'acc-cogs-au', tenantId: 't1', code: '5000', name: 'COGS', accountType: 'expense', isActive: true },
];
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const net = (acct: string) => memDb.table('abJournalLine').rows.filter((l) => l.accountId === acct)
  .reduce((s, l) => s + (l.debitCents as number) - (l.creditCents as number), 0);
const item = () => memDb.table('abInventoryItem').rows.find((i) => i.id === 'item-1')!;

function seed(trackInventory = true, jurisdiction = 'us') {
  memDb.reset(
    {
      abAccount: ACCOUNTS, abFiscalPeriod: [], abStockMovement: [], abInvoice: [], abInvoiceLine: [], abPayment: [],
      abClient: [{ id: 'c1', tenantId: 't1', name: 'Client', totalBilledCents: 0 }],
      abEvent: [], abSalesTaxCollected: [], abDeferredRevenue: [],
      abTenantConfig: [{ userId: 't1', currency: 'USD', jurisdiction, trackInventory }],
      // 10 units worth $50.00 already on hand (1500 balance seeded to match).
      abInventoryItem: [{ id: 'item-1', tenantId: 't1', name: 'Widget', unit: 'each', onHandQty: '10.0000', onHandValueCents: 5000, isActive: true, deletedAt: null }],
      abJournalEntry: [{ id: 'je-open', tenantId: 't1', date: new Date('2026-01-01'), sourceType: 'stock_opening', sourceId: 'item-1' }],
      abJournalLine: [{ id: 'jl-open', tenantId: 't1', entryId: 'je-open', accountId: 'acc-inv', debitCents: 5000, creditCents: 0 }],
    },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']], abStockMovement: [['tenantId', 'sourceType', 'sourceId']] } },
  );
}
async function call(h: unknown, path: string, init: Row = {}, id?: string, tenant = 't1') {
  const res = await (h as (r: never, c: never) => Promise<Response>)(tenantReq(path, tenant, init as never) as never, (id ? ctx(id) : undefined) as never);
  return { status: res.status, body: await json<{ success: boolean; data: Row; error?: string }>(res) };
}
const createInvoice = (lines: Row[], tenant = 't1') => call(CREATE, '/api/v1/agentbook-invoice/invoices', {
  method: 'POST', body: { clientId: 'c1', issuedDate: '2026-11-10', dueDate: '2026-12-10', lines },
}, undefined, tenant);

beforeEach(() => seed());

describe('invoice create posts COGS', () => {
  it('an item line relieves stock at WAC: DR 5990 | CR 1500, sourceId = the invoice line id', async () => {
    const r = await createInvoice([
      { description: 'Widgets', quantity: 4, rateCents: 1500, itemId: 'item-1' },
      { description: 'Service', quantity: 1, rateCents: 10000 },
    ]);
    expect(r.status).toBe(201);
    const lines = r.body.data.lines as Row[];
    const itemLine = lines.find((l) => l.itemId === 'item-1')!;
    expect(net('acc-cogs')).toBe(2000);
    expect(net('acc-inv')).toBe(3000);
    expect(net('acc-rev')).toBe(-16000);
    expect(item().onHandValueCents).toBe(3000);
    const sales = memDb.table('abJournalEntry').rows.filter((e) => e.sourceType === 'stock_sale');
    expect(sales.map((e) => e.sourceId)).toEqual([itemLine.id]);
  });

  it('no COGS when trackInventory is off, or the line has no itemId', async () => {
    seed(false);
    await createInvoice([{ description: 'Widgets', quantity: 4, rateCents: 1500, itemId: 'item-1' }]);
    expect(net('acc-cogs')).toBe(0);
    seed(true);
    await createInvoice([{ description: 'Widgets', quantity: 4, rateCents: 1500 }]);
    expect(net('acc-cogs')).toBe(0);
    expect(item().onHandValueCents).toBe(5000);
  });

  it('AU books COGS to 5000', async () => {
    seed(true, 'au');
    await createInvoice([{ description: 'Widgets', quantity: 10, rateCents: 1500, itemId: 'item-1' }]);
    expect(net('acc-cogs-au')).toBe(5000);
    expect(net('acc-cogs')).toBe(0);
    expect(net('acc-inv')).toBe(0);
  });

  it('a cross-tenant itemId is 404 and books nothing', async () => {
    memDb.table('abClient').rows.push({ id: 'c2', tenantId: 't2', name: 'X', totalBilledCents: 0 });
    const r = await call(CREATE, '/api/v1/agentbook-invoice/invoices', { method: 'POST', body: { clientId: 'c2', lines: [{ quantity: 1, rateCents: 100, itemId: 'item-1' }] } }, undefined, 't2');
    expect(r.status).toBe(404);
    expect(memDb.table('abInvoice').rows).toHaveLength(0);
  });

  it('selling more than on hand succeeds (negative stock, value relieved to 0)', async () => {
    const r = await createInvoice([{ description: 'Widgets', quantity: 12, rateCents: 1500, itemId: 'item-1' }]);
    expect(r.status).toBe(201);
    expect(item().onHandQty).toBe('-2.0000');
    expect(item().onHandValueCents).toBe(0);
    expect(net('acc-cogs')).toBe(5000);
  });
});

describe('invoice void and edit', () => {
  it('void posts stock_sale_void and restores 1500 / COGS to baseline', async () => {
    const r = await createInvoice([{ description: 'Widgets', quantity: 3, rateCents: 1500, itemId: 'item-1' }]);
    const v = await call(VOID, `/x/${r.body.data.id}/void`, { method: 'POST' }, r.body.data.id as string);
    expect(v.status).toBe(200);
    expect(net('acc-cogs')).toBe(0);
    expect(net('acc-inv')).toBe(5000);
    expect(net('acc-rev')).toBe(0);
    expect(item().onHandQty).toBe('10.0000');
    expect(memDb.table('abJournalEntry').rows.filter((e) => e.sourceType === 'stock_sale_void')).toHaveLength(1);
  });

  it('PATCH line qty 2 → 6 reverses and reposts revenue and COGS; void then clears all', async () => {
    const r = await createInvoice([{ description: 'Widgets', quantity: 2, rateCents: 1500, itemId: 'item-1' }]);
    const id = r.body.data.id as string;
    const lineId = (r.body.data.lines as Row[])[0].id as string;
    expect(net('acc-cogs')).toBe(1000);
    const p = await call(PATCH, `/x/${id}`, { method: 'PATCH', body: { lines: [{ id: lineId, quantity: 6 }] } }, id);
    expect(p.status).toBe(200);
    expect(p.body.data.amountCents).toBe(9000);
    expect(net('acc-rev')).toBe(-9000);
    expect(net('acc-ar')).toBe(9000);
    expect(net('acc-cogs')).toBe(3000);
    expect(item().onHandQty).toBe('4.0000');
    expect(memDb.table('abClient').rows[0].totalBilledCents).toBe(9000);
    await call(VOID, `/x/${id}/void`, { method: 'POST' }, id);
    expect(net('acc-rev')).toBe(0);
    expect(net('acc-ar')).toBe(0);
    expect(net('acc-cogs')).toBe(0);
    expect(net('acc-inv')).toBe(5000);
  });

  it('PATCH lines on a sent invoice is refused', async () => {
    const r = await createInvoice([{ description: 'Widgets', quantity: 2, rateCents: 1500, itemId: 'item-1' }]);
    const id = r.body.data.id as string;
    memDb.table('abInvoice').rows[0].status = 'sent';
    const p = await call(PATCH, `/x/${id}`, { method: 'PATCH', body: { lines: [{ id: (r.body.data.lines as Row[])[0].id, quantity: 6 }] } }, id);
    expect(p.status).toBe(422);
    expect(net('acc-cogs')).toBe(1000);
  });
});

describe('COGS by period route', () => {
  it('reports the month net of voids', async () => {
    await createInvoice([{ description: 'W', quantity: 4, rateCents: 1500, itemId: 'item-1' }]);
    const r = await call(COGS, '/api/v1/agentbook-expense/inventory/cogs?from=2026-01-01&to=2027-01-01');
    expect(r.status).toBe(200);
    expect(r.body.data.periods).toEqual([{ period: '2026-11', cogsCents: 2000 }]);
    expect(r.body.data.totalCents).toBe(2000);
  });
});
