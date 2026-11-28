import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch finding F6: marking a tax deposit paid only flipped its status, so
 * Payroll Liabilities never cleared and cash stayed overstated. Paying must
 * post Dr liability / Cr cash exactly once, and respect the period lock.
 */
type Row = Record<string, any>;
let dep: Row;
let entries: Row[];
let lines: Row[];
let closed: boolean;

const db: Row = {
  abPayrollTaxDeposit: {
    findFirst: async () => ({ ...dep }),
    updateMany: async ({ data }: Row) => {
      if (dep.status === 'paid') return { count: 0 };
      Object.assign(dep, data);
      return { count: 1 };
    },
  },
  abAccount: { findFirst: async ({ where }: Row) => ({ id: where.code === '1000' ? 'cash' : where.code === '2300' ? 'super' : 'payroll-liab' }) },
  abFiscalPeriod: { findUnique: async () => (closed ? { status: 'closed' } : null) },
  abJournalEntry: { create: async ({ data }: Row) => { entries.push(data); return { id: `je${entries.length}` }; } },
  abJournalLine: { create: async ({ data }: Row) => { lines.push(data); return data; } },
};
db.$transaction = (fn: (tx: Row) => unknown) => fn(db);

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ get prisma() { return db; } }));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));

import { POST } from '@/app/api/v1/agentbook-payroll/tax-deposits/route';

const pay = () => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ id: 'd1' }) }) as never);

beforeEach(() => {
  dep = { id: 'd1', tenantId: 't1', form: 't4', periodLabel: '2026-Q4', amountCents: 123456, status: 'pending' };
  entries = []; lines = []; closed = false;
});

describe('mark tax deposit paid', () => {
  it('posts Dr Payroll Liabilities / Cr Cash for the deposit amount, keyed on the deposit', async () => {
    const res = await pay();
    expect(res.status).toBe(200);
    expect(entries[0]).toMatchObject({ sourceType: 'payroll_deposit', sourceId: 'd1' });
    expect(lines).toEqual([
      expect.objectContaining({ accountId: 'payroll-liab', debitCents: 123456, creditCents: 0 }),
      expect.objectContaining({ accountId: 'cash', debitCents: 0, creditCents: 123456 }),
    ]);
    expect(dep.status).toBe('paid');
  });

  it('superannuation clears Superannuation Payable (2300), not payroll liabilities', async () => {
    dep.form = 'sg';
    await pay();
    expect(lines[0]).toMatchObject({ accountId: 'super', debitCents: 123456 });
  });

  it('paying twice is a 409 and posts nothing the second time', async () => {
    await pay();
    const res = await pay();
    expect(res.status).toBe(409);
    expect(entries).toHaveLength(1);
  });

  it('a closed period refuses the payment and leaves it pending', async () => {
    closed = true;
    const res = await pay();
    expect(res.status).toBe(422);
    expect(dep.status).toBe('pending');
    expect(entries).toHaveLength(0);
  });
});
