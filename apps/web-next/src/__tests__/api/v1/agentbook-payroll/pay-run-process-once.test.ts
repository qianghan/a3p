import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch finding F1: the "already processed" check ran outside the
 * transaction and the journal had no sourceId, so two concurrent clicks (or a
 * retry) each posted payroll and accrued deposits twice. The route must claim
 * the run inside the transaction and key the journal on the run id.
 */
type Row = Record<string, any>;
let run: Row;
let journals: Row[];
let deposits: Row[];
let periods: Row[];
let missingCash: boolean;

// Serialises transactions like the row lock on abPayRun would.
let queue: Promise<unknown> = Promise.resolve();
const db: Row = {
  abPayRun: {
    findFirst: async () => ({ ...run, stubs: run.stubs }),
    updateMany: async ({ where, data }: Row) => {
      if (where.id !== run.id || where.status.notIn.includes(run.status)) return { count: 0 };
      Object.assign(run, data);
      return { count: 1 };
    },
    update: async ({ data }: Row) => Object.assign(run, data),
  },
  abAccount: {
    findFirst: async ({ where }: Row) => (missingCash && where.code === '1000' ? null : { id: `acct-${where.code ?? where.accountType}` }),
    create: async ({ data }: Row) => ({ id: `acct-${data.code}`, ...data }),
  },
  abFiscalPeriod: { findUnique: async () => periods[0] ?? null },
  abTenantConfig: { findUnique: async () => ({ jurisdiction: 'us' }) },
  abJournalEntry: { create: async ({ data }: Row) => { journals.push(data); return { id: `je${journals.length}` }; } },
  abPayrollTaxDeposit: {
    findUnique: async () => null,
    create: async ({ data }: Row) => { deposits.push(data); return data; },
    update: async () => ({}),
  },
};
db.$transaction = (fn: (tx: Row) => unknown) => {
  const next = queue.then(() => fn(db));
  queue = next.catch(() => undefined);
  return next;
};

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ get prisma() { return db; } }));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));

import { POST } from '@/app/api/v1/agentbook-payroll/pay-runs/[id]/process/route';

const call = () => POST(new Request('http://x', { method: 'POST' }) as never, { params: Promise.resolve({ id: 'r1' }) });

beforeEach(() => {
  journals = [];
  deposits = [];
  periods = [];
  missingCash = false;
  db.abJournalEntry.create = async ({ data }: Row) => { journals.push(data); return { id: `je${journals.length}` }; };
  run = {
    id: 'r1', tenantId: 't1', status: 'draft',
    periodStart: new Date('2026-11-01T00:00:00Z'), periodEnd: new Date('2026-11-14T00:00:00Z'), payDate: null,
    stubs: [{ grossCents: 100000, federalTaxCents: 4385, stateTaxCents: 0, ficaCents: 7650, otherDeductCents: 0, netCents: 87965, sgCents: 0 }],
  };
});

describe('process pay run — exactly once', () => {
  it('two concurrent requests post one journal and one set of deposits; the second gets 409', async () => {
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(journals).toHaveLength(1);
    expect(deposits.filter((d) => d.form === '941')).toHaveLength(1);
  });

  it('the journal is keyed on the run so the unique index backs the guard', async () => {
    await call();
    expect(journals[0]).toMatchObject({ sourceType: 'payroll', sourceId: 'r1' });
  });

  it('a unique-index collision (P2002) is reported as already processed, not a 500', async () => {
    db.abJournalEntry.create = async () => { throw Object.assign(new Error('dup'), { code: 'P2002' }); };
    const res = await call();
    expect(res.status).toBe(409);
  });
});

describe('process pay run — ledger guards (F4, F7) and employer-tax accrual', () => {
  it('F4: a run whose period is closed is refused with 422 and stays unpaid', async () => {
    periods = [{ status: 'closed' }];
    const res = await call();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('period_closed');
    expect(run.status).toBe('draft');
    expect(journals).toHaveLength(0);
  });

  it('F7: with no cash account the run is refused, not marked paid without a journal', async () => {
    missingCash = true;
    const res = await call();
    expect(res.status).toBe(422);
    expect(run.status).toBe('draft');
    expect(deposits).toHaveLength(0);
  });

  it('US: employer FICA match + FUTA are credited to the liability, so it equals the 941 + 940 deposits', async () => {
    await call();
    const lines = journals[0].lines.create as Row[];
    const liabCredit = lines.filter((l) => l.accountId === 'acct-liability').reduce((s, l) => s + l.creditCents, 0);
    const dep = deposits.filter((d) => d.form === '941' || d.form === '940').reduce((s, d) => s + d.amountCents, 0);
    expect(liabCredit).toBe(dep);
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
  });
});
