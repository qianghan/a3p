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
    findUnique: vi.fn(async ({ where }: { where: Row }) => { const r = runs.find((x) => x.id === where.id); return r ? { ...r, stubs: stubs.filter((s) => s.payRunId === r.id) } : null; }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const before = runs.length; runs = runs.filter((r) => !matches(r, where)); return { count: before - runs.length }; }),
  },
  abPayStub: {
    create: vi.fn(async ({ data }: { data: Row }) => { stubs.push(data); return data; }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => { const b = stubs.length; stubs = stubs.filter((s) => !matches(s, where)); return { count: b - stubs.length }; }),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
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
  seq = 0; runs = []; stubs = [];
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
