/**
 * PR 4c — POST /pay-runs { generate: 'drafts' } creates one draft per
 * frequency group from each employee's payAnchorDate, storing payDate and
 * payFrequency; DELETE /pay-runs/[id] removes a DRAFT only.
 *
 * The DB mock applies the where clause (tenant, isActive, id filter) so a
 * dropped filter fails the test instead of passing on a fixed array.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;
let employees: Row[] = [];
let runs: Row[] = [];
let stubs: Row[] = [];
let seq = 0;
let injectTxErrors: string[] = [];
let txLock: Promise<unknown> = Promise.resolve();
const txOpts: unknown[] = [];

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
    if (v instanceof Date) return row[k] instanceof Date && (row[k] as Date).getTime() === v.getTime();
    return row[k] === v;
  });
}

const db = {
  abEmployee: { findMany: vi.fn(async ({ where }: { where: Row }) => employees.filter((e) => matches(e, where))) },
  abPayRun: {
    create: vi.fn(async ({ data }: { data: Row }) => { const r = { id: `run-${++seq}`, status: 'draft', ...data }; runs.push(r); return r; }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => runs.find((r) => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where }: { where: Row }) => runs.filter((r) => matches(r, where)).map((r) => ({ ...r, stubs: stubs.filter((s) => s.payRunId === r.id) }))),
    findUnique: vi.fn(async ({ where }: { where: Row }) => { const r = runs.find((x) => x.id === where.id); return r ? { ...r, stubs: stubs.filter((s) => s.payRunId === r.id) } : null; }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const before = runs.length; runs = runs.filter((r) => !matches(r, where)); return { count: before - runs.length }; }),
  },
  abPayStub: {
    create: vi.fn(async ({ data }: { data: Row }) => { stubs.push(data); return data; }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const b = stubs.length; stubs = stubs.filter((s) => !matches(s, where)); return { count: b - stubs.length }; }),
  },
  // Serializable stand-in: transactions run one at a time; an injected code aborts the attempt before it runs.
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown, opts?: unknown) => {
    txOpts.push(opts);
    const prev = txLock;
    let release!: () => void;
    txLock = new Promise<void>((res) => { release = res; });
    await prev;
    try {
      const code = injectTxErrors.shift();
      if (code) throw Object.assign(new Error('serialization failure'), { code });
      return await fn(db);
    } finally { release(); }
  }),
};

vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, k) => (db as Record<string, unknown>)[k as string] }) }));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 't1' })) }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/agentbook-payroll/pay-runs/route';
import { DELETE } from '@/app/api/v1/agentbook-payroll/pay-runs/[id]/route';
import { periodGross } from '@/lib/payroll-engine';

const req = (body: unknown) => new NextRequest('https://x.test/api/v1/agentbook-payroll/pay-runs', { method: 'POST', body: JSON.stringify(body) });
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const emp = (o: Row): Row => ({
  tenantId: 't1', isActive: true, payType: 'salary', payRateCents: 5_200_000, jurisdiction: 'us', region: 'TX',
  filingStatus: 'single', startDate: d('2025-01-08'), createdAt: d('2025-01-08'), payAnchorDate: null, ...o,
});

beforeEach(() => {
  seq = 0; runs = []; stubs = []; injectTxErrors = []; txOpts.length = 0;
  employees = [
    emp({ id: 'a', name: 'A Weekly', payFrequency: 'weekly', payAnchorDate: d('2026-01-05') }),
    emp({ id: 'b', name: 'B Biweekly', payFrequency: 'biweekly', payAnchorDate: d('2025-12-22'), jurisdiction: 'au', region: '' }),
    emp({ id: 'c', name: 'C Semi', payFrequency: 'semimonthly' }),
    emp({ id: 'm', name: 'M Monthly', payFrequency: 'monthly' }),
    emp({ id: 'x', name: 'X Other tenant', payFrequency: 'monthly', tenantId: 't2' }),
    emp({ id: 'z', name: 'Z Inactive', payFrequency: 'monthly', isActive: false }),
  ];
});

describe('POST /pay-runs { generate: "drafts" }', () => {
  it('creates one draft per frequency group with computed period, payDate and payFrequency', async () => {
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-20' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const byFreq = Object.fromEntries(body.data.runs.map((r: Row) => [r.payFrequency, r]));
    expect(Object.keys(byFreq).sort()).toEqual(['biweekly', 'monthly', 'semimonthly', 'weekly']);
    // weekly from 2026-01-05: 2026-02-20 is 46 days on → 6 weeks → 2026-02-16..22
    expect([byFreq.weekly.periodStart, byFreq.weekly.periodEnd, byFreq.weekly.payDate]).toEqual([d('2026-02-16'), d('2026-02-22'), d('2026-02-22')].map((x) => x.toISOString()));
    // biweekly from 2025-12-22: +60 days → 4 periods → 2026-02-16..03-01
    expect(byFreq.biweekly.periodStart).toBe(d('2026-02-16').toISOString());
    expect(byFreq.biweekly.periodEnd).toBe(d('2026-03-01').toISOString());
    expect(byFreq.semimonthly.periodStart).toBe(d('2026-02-16').toISOString());
    expect(byFreq.semimonthly.periodEnd).toBe(d('2026-02-28').toISOString());
    expect(byFreq.monthly.periodEnd).toBe(d('2026-02-28').toISOString());
    // stubs: only that group's employees; other tenant and inactive never paid
    const names = (r: Row) => (r.stubs as Row[]).map((s) => s.employeeName);
    expect(names(byFreq.monthly)).toEqual(['M Monthly']);
    expect(stubs.map((s) => s.employeeId).sort()).toEqual(['a', 'b', 'c', 'm']);
    // the run reads the CURRENT rate: weekly gross = 52,000.00 / 52
    expect((byFreq.weekly.stubs as Row[])[0].grossCents).toBe(periodGross(5_200_000, 'weekly'));
    expect(periodGross(5_200_000, 'weekly')).toBe(100_000);
  });

  it('is idempotent per group+period: a second call returns the existing draft, creates nothing', async () => {
    await POST(req({ generate: 'drafts', asOf: '2026-02-20' }));
    const n = runs.length;
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-21' }));
    const body = await res.json();
    expect(runs.length).toBe(n);
    expect(body.data.runs.every((r: Row) => r.created === false)).toBe(true);
  });

  it('employeeIds limits the drafts to those employees (tenant-scoped)', async () => {
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-20', employeeIds: ['m', 'x'] }));
    const body = await res.json();
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].payFrequency).toBe('monthly');
    expect(stubs.map((s) => s.employeeId)).toEqual(['m']);
  });

  it('a changed rate applies to the NEXT draft only — an existing run keeps its stub', async () => {
    await POST(req({ generate: 'drafts', asOf: '2026-01-10', employeeIds: ['m'] }));
    (employees.find((e) => e.id === 'm') as Row).payRateCents = 10_400_000;
    await POST(req({ generate: 'drafts', asOf: '2026-02-10', employeeIds: ['m'] }));
    expect(stubs.map((s) => s.grossCents)).toEqual([periodGross(5_200_000, 'monthly'), periodGross(10_400_000, 'monthly')]);
    expect(stubs.map((s) => s.grossCents)).toEqual([433_333, 866_667]);
  });

  it('a weekly employee without an anchor falls back to startDate', async () => {
    employees = [emp({ id: 'w', name: 'W', payFrequency: 'weekly', startDate: d('2026-02-02') })];
    const body = await (await POST(req({ generate: 'drafts', asOf: '2026-02-20' }))).json();
    expect(body.data.runs[0].periodStart).toBe(d('2026-02-16').toISOString());
  });

  it('400 on a malformed asOf; 400 when no active employees match', async () => {
    expect((await POST(req({ generate: 'drafts', asOf: '2026-02-30' }))).status).toBe(400);
    expect((await POST(req({ generate: 'drafts', employeeIds: ['nope'] }))).status).toBe(400);
  });
});

describe('draft extension, conflicts and concurrency (review I1/I2)', () => {
  const stubIds = (runId: string) => stubs.filter((s) => s.payRunId === runId).map((s) => s.employeeId).sort();

  it('two fortnightly groups 14·k days apart share a period → ONE draft holding both', async () => {
    employees = [
      emp({ id: 'f1', name: 'F1', payFrequency: 'biweekly', payAnchorDate: d('2026-01-05') }),
      emp({ id: 'f2', name: 'F2', payFrequency: 'biweekly', payAnchorDate: d('2026-02-02') }), // +28 days
    ];
    const body = await (await POST(req({ generate: 'drafts', asOf: '2026-02-20' }))).json();
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].periodStart).toBe(d('2026-02-16').toISOString());
    expect(stubIds(body.data.runs[0].id)).toEqual(['f1', 'f2']);
  });

  it('fortnightly groups 7 days apart get separate drafts', async () => {
    employees = [
      emp({ id: 'f1', name: 'F1', payFrequency: 'biweekly', payAnchorDate: d('2026-01-05') }),
      emp({ id: 'f3', name: 'F3', payFrequency: 'biweekly', payAnchorDate: d('2026-01-12') }),
    ];
    const body = await (await POST(req({ generate: 'drafts', asOf: '2026-02-20' }))).json();
    const periods = body.data.runs.map((r: Row) => [r.periodStart, stubIds(r.id as string)]).sort();
    expect(periods).toEqual([[d('2026-02-09').toISOString(), ['f3']], [d('2026-02-16').toISOString(), ['f1']]]);
  });

  it('a subset then the full set extends the same draft (addedStubs), never duplicating a stub', async () => {
    employees = [
      emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' }),
      emp({ id: 'm2', name: 'M2', payFrequency: 'monthly' }),
    ];
    const first = await (await POST(req({ generate: 'drafts', asOf: '2026-02-10', employeeIds: ['m1'] }))).json();
    expect(first.data.runs[0]).toMatchObject({ created: true, addedStubs: 1 });
    const second = await (await POST(req({ generate: 'drafts', asOf: '2026-02-10' }))).json();
    expect(runs).toHaveLength(1);
    expect(second.data.runs[0]).toMatchObject({ id: first.data.runs[0].id, created: false, addedStubs: 1 });
    expect(stubIds(runs[0].id as string)).toEqual(['m1', 'm2']);
  });

  it('an employee added after the draft is added to it', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    await POST(req({ generate: 'drafts', asOf: '2026-02-10' }));
    employees.push(emp({ id: 'm9', name: 'M9 late', payFrequency: 'monthly' }));
    const body = await (await POST(req({ generate: 'drafts', asOf: '2026-02-11' }))).json();
    expect(body.data.runs[0].addedStubs).toBe(1);
    expect(stubIds(runs[0].id as string)).toEqual(['m1', 'm9']);
  });

  it('a legacy run without payFrequency for the same period is treated as the draft (dedupe)', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    runs.push({ id: 'legacy', tenantId: 't1', status: 'draft', periodStart: d('2026-02-01'), periodEnd: d('2026-02-28'), payFrequency: null });
    const body = await (await POST(req({ generate: 'drafts', asOf: '2026-02-10' }))).json();
    expect(runs).toHaveLength(1);
    expect(body.data.runs[0]).toMatchObject({ id: 'legacy', created: false, addedStubs: 1 });
  });

  it('a processed run for the period → 409 period_already_processed naming the employees, nothing written', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    runs.push({ id: 'done', tenantId: 't1', status: 'processed', periodStart: d('2026-02-01'), periodEnd: d('2026-02-28'), payFrequency: 'monthly' });
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-10' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_already_processed');
    expect(body.employeeIds).toEqual(['m1']);
    expect(runs).toHaveLength(1);
    expect(stubs).toHaveLength(0);
  });

  it('concurrent generate calls create ONE draft with one stub each (Serializable tx)', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    const [a, b] = await Promise.all([POST(req({ generate: 'drafts', asOf: '2026-02-10' })), POST(req({ generate: 'drafts', asOf: '2026-02-10' }))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(runs).toHaveLength(1);
    expect(stubs).toHaveLength(1);
    expect(txOpts.every((o) => (o as { isolationLevel?: string })?.isolationLevel === 'Serializable')).toBe(true);
  });

  it('a P2034 abort is retried and succeeds', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    injectTxErrors.push('P2034');
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-10' }));
    expect(res.status).toBe(201);
    expect(runs).toHaveLength(1);
  });

  it('exhausted P2034 retries → 409 concurrent_update, nothing written', async () => {
    employees = [emp({ id: 'm1', name: 'M1', payFrequency: 'monthly' })];
    injectTxErrors.push('P2034', 'P2034', 'P2034');
    const res = await POST(req({ generate: 'drafts', asOf: '2026-02-10' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent_update');
    expect(runs).toHaveLength(0);
  });
});

describe('DELETE /pay-runs/[id]', () => {
  const del = (id: string) => DELETE(new NextRequest(`https://x.test/api/v1/agentbook-payroll/pay-runs/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
  it('deletes a draft and its stubs', async () => {
    await POST(req({ generate: 'drafts', asOf: '2026-02-20', employeeIds: ['m'] }));
    const res = await del('run-1');
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(0);
    expect(stubs).toHaveLength(0);
  });
  it('refuses a processed run (409) and another tenant’s run (404)', async () => {
    runs.push({ id: 'p1', tenantId: 't1', status: 'processed' }, { id: 'o1', tenantId: 't2', status: 'draft' });
    expect((await del('p1')).status).toBe(409);
    expect((await del('o1')).status).toBe(404);
    expect(runs).toHaveLength(2);
  });
});
