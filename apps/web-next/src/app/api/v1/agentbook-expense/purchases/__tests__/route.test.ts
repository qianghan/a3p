import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const expenseFind = vi.fn();
const expenseCount = vi.fn();
const billFind = vi.fn();
const cfgFind = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: { findMany: (...a: unknown[]) => expenseFind(...a), count: (...a: unknown[]) => expenseCount(...a) },
    abBill: { findMany: (...a: unknown[]) => billFind(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => cfgFind(...a) },
  },
}));

import { GET } from '../route';

const req = (qs = '') => ({ nextUrl: new URL(`http://x/api/v1/agentbook-expense/purchases${qs}`), headers: new Headers() }) as never;
const bill = (o: Record<string, unknown>) => ({
  id: 'b1', vendorName: 'Acme', amountCents: 12000, status: 'open', paidCents: 0, billDate: d('2026-10-05'),
  createdAt: d('2026-10-01'), dueDate: d('2026-12-05'), deletedAt: null, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  expenseFind.mockResolvedValue([
    { id: 'e1', date: d('2026-10-07'), amountCents: 5000, vendor: { name: 'Staples' } },
    { id: 'e2', date: d('2026-10-02'), amountCents: 700, vendor: null, description: 'Taxi' },
  ]);
  expenseCount.mockResolvedValue(2);
  cfgFind.mockResolvedValue({ timezone: 'UTC' });
  billFind.mockResolvedValue([
    bill({ id: 'b1' }),
    bill({ id: 'b2', status: 'paid', paidCents: 0, vendorName: 'Landlord', amountCents: 90000, billDate: null, createdAt: d('2026-10-03') }),
    bill({ id: 'b3', status: 'partial', paidCents: 5000, billDate: d('2026-09-20') }),
  ]);
});

describe('GET /purchases', () => {
  it('merges expenses and bills, newest first, with due/paid badges', async () => {
    const body = await (await GET(req())).json();
    expect(body.success).toBe(true);
    expect(body.data.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`))
      .toEqual(['expense:e1', 'bill:b1', 'bill:b2', 'expense:e2', 'bill:b3']);
    const by = Object.fromEntries(body.data.map((r: { id: string }) => [r.id, r]));
    expect(by.b1).toMatchObject({ status: 'due', amountCents: 12000, outstandingCents: 12000, vendor: 'Acme' });
    expect(by.b3).toMatchObject({ status: 'due', amountCents: 12000, outstandingCents: 7000 });
    expect(by.b2).toMatchObject({ status: 'paid', amountCents: 90000, outstandingCents: 0, date: '2026-10-03T00:00:00.000Z' });
    expect(by.e1).toMatchObject({ status: null, vendor: 'Staples', amountCents: 5000 });
    expect(by.e2.vendor).toBe('Taxi');
    expect(body.meta).toMatchObject({ total: 5, limit: 50, offset: 0 });
  });

  it('shows a paid bill once: a single bill row, no expense row for its payment', async () => {
    const body = await (await GET(req())).json();
    const rows = body.data.filter((r: { id: string }) => r.id === 'b2');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('bill');
    expect(body.data.filter((r: { kind: string }) => r.kind === 'expense')).toHaveLength(2);
  });

  it('is tenant-scoped, hides deleted rows and cancelled/void bills', async () => {
    await GET(req());
    expect(expenseFind.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', deletedAt: null, archivedAt: null });
    expect(billFind.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', deletedAt: null, status: { in: ['open', 'partial', 'paid'] } });
  });

  it('paginates the merged list and filters bills by date range', async () => {
    const page = await (await GET(req('?limit=2&offset=1'))).json();
    expect(page.data.map((r: { id: string }) => r.id)).toEqual(['b1', 'b2']);
    const ranged = await (await GET(req('?startDate=2026-10-01'))).json();
    expect(ranged.data.map((r: { id: string }) => r.id)).not.toContain('b3');
    expect(ranged.meta.total).toBe(2 + 2);
  });

  it('orders bills deterministically and judges overdue in the tenant timezone', async () => {
    await GET(req());
    expect(billFind.mock.calls[0][0].orderBy).toEqual([{ billDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T01:00:00.000Z')); // 17:00 PT Nov 5
    billFind.mockResolvedValue([bill({ id: 'bt', dueDate: d('2026-11-05') })]);
    cfgFind.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const la = await (await GET(req('?kind=bill'))).json();
    cfgFind.mockResolvedValue({ timezone: 'UTC' });
    const utc = await (await GET(req('?kind=bill'))).json();
    vi.useRealTimers();
    expect(la.data[0].overdue).toBe(false);
    expect(utc.data[0].overdue).toBe(true);
  });

  it('kind=bill returns bill rows only and never queries expenses', async () => {
    const body = await (await GET(req('?kind=bill'))).json();
    expect(body.data.every((r: { kind: string }) => r.kind === 'bill')).toBe(true);
    expect(body.meta.total).toBe(3);
    expect(expenseFind).not.toHaveBeenCalled();
  });

  it('wiring: the route reads bills through the shared helpers', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'route.ts'), 'utf8');
    expect(src).toContain('liveBillWhere()');
    expect(src).toContain('billToPurchase');
  });
});
