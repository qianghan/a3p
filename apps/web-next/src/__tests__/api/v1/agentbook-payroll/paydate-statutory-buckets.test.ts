/**
 * PR 4d — statutory reports bucket by payDate ?? periodEnd; the payroll
 * journal stays on periodEnd (owner call O1).
 *
 * The DB mock APPLIES the where clause (OR / null / gte / lt / lte / payRun
 * relation), so a route that still filters on periodEnd puts a run in the
 * wrong bucket and these assertions fail.
 *
 * Fixture (one employee e1), crossing a BAS quarter AND a year boundary:
 *   r0  period ends 2026-06-30, paid 2026-07-02  gross  30,000  (AU FY + Q2→Q3)
 *   r3  period ends 2026-09-15, payDate null     gross  50,000  (legacy → periodEnd)
 *   r1  period ends 2026-09-30, paid 2026-10-03  gross 100,000  (Q3→Q4)
 *   r2  period ends 2026-12-31, paid 2027-01-02  gross 200,000  (2026→2027)
 * PAYG/federal = 20% of gross, super = 12%, FICA = 5%.
 */
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

type Row = Record<string, any>;
const state: { runs: Row[]; stubs: Row[]; deposits: Row[]; journals: Row[]; jurisdiction: string } = {
  runs: [], stubs: [], deposits: [], journals: [], jurisdiction: 'au',
};

function matchValue(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === 'object' && cond !== null) {
    const c = cond as Record<string, any>;
    if ('in' in c) return c.in.includes(v);
    if ('not' in c) return c.not === null ? v !== null && v !== undefined : v !== c.not;
    if (v === null || v === undefined) return false;
    const t = (v as Date).getTime();
    if (c.gte && !(t >= c.gte.getTime())) return false;
    if (c.gt && !(t > c.gt.getTime())) return false;
    if (c.lt && !(t < c.lt.getTime())) return false;
    if (c.lte && !(t <= c.lte.getTime())) return false;
    return true;
  }
  return v === cond;
}
function match(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') { if (!(cond as Row[]).some((w) => match(row, w))) return false; continue; }
    if (k === 'payRun') { const run = state.runs.find((r) => r.id === row.payRunId); if (!run || !match(run, cond as Row)) return false; continue; }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}
const withStubs = (r: Row) => ({ ...r, stubs: state.stubs.filter((s) => s.payRunId === r.id) });
function sortRuns(rows: Row[], orderBy?: Row) {
  if (!orderBy) return rows;
  const [k, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((a, b) => (dir === 'desc' ? -1 : 1) * (a[k].getTime() - b[k].getTime()));
}

const db: Row = {
  abTenantConfig: { findUnique: async () => ({ jurisdiction: state.jurisdiction, companyName: 'Fixture Co', gstRegistered: true }) },
  abEmployee: {
    findMany: async () => [{ id: 'e1', name: 'Ann', jurisdiction: null, region: null }],
    findFirst: async () => ({ id: 'e1', name: 'Ann', jurisdiction: null, region: null }),
  },
  abPayRun: {
    findFirst: async ({ where, orderBy }: Row) => { const r = sortRuns(state.runs.filter((x) => match(x, where)), orderBy)[0]; return r ? withStubs(r) : null; },
    findMany: async ({ where }: Row) => state.runs.filter((x) => match(x, where)).map(withStubs),
    update: async ({ where, data }: Row) => { const r = state.runs.find((x) => x.id === where.id)!; Object.assign(r, data); return withStubs(r); },
  },
  abPayStub: { findMany: async ({ where }: Row) => state.stubs.filter((s) => match(s, where)) },
  abInvoice: { findMany: async () => [] },
  abExpense: { findMany: async () => [] },
  abBill: { findMany: async () => [] },
  abAccount: {
    findFirst: async ({ where }: Row) => ({ id: `acct-${where.code ?? where.accountType}`, code: where.code ?? '5000' }),
    create: async ({ data }: Row) => ({ id: `acct-${data.code}`, ...data }),
  },
  abJournalEntry: { create: async ({ data }: Row) => { const je = { id: `je${state.journals.length + 1}`, ...data }; state.journals.push(je); return je; } },
  abPayrollTaxDeposit: {
    findUnique: async ({ where }: Row) => state.deposits.find((d) => d.form === where.tenantId_form_periodLabel.form && d.periodLabel === where.tenantId_form_periodLabel.periodLabel) ?? null,
    findFirst: async ({ where }: Row) => state.deposits.find((d) => d.id === where.id) ?? null,
    create: async ({ data }: Row) => { const d = { id: `d${state.deposits.length + 1}`, ...data }; state.deposits.push(d); return d; },
    update: async ({ where, data }: Row) => { const d = state.deposits.find((x) => x.id === where.id)!; Object.assign(d, data); return d; },
  },
};
db.$transaction = async (fn: (tx: Row) => unknown) => fn(db);

vi.mock('@naap/database', () => ({ get prisma() { return db; } }));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));
// Year-end form builder: sum gross so the bucket is visible as a number.
vi.mock('@/lib/year-end-forms', () => ({
  buildYearEndForm: (name: string, _j: string, year: number, stubs: Row[], employeeId: string) => ({
    employeeName: name, employeeId, year, formType: 'W-2', boxes: { grossCents: stubs.reduce((a, s) => a + s.grossCents, 0) },
  }),
}));
const pdfCalls: Row[] = [];
vi.mock('@/lib/payroll-forms-pdf', () => ({
  renderW2Pdf: async (x: Row) => { pdfCalls.push({ kind: 'w2', ...x }); return Buffer.from('pdf'); },
  render941Pdf: async (x: Row) => { pdfCalls.push({ kind: '941', ...x }); return Buffer.from('pdf'); },
  render940Pdf: async (x: Row) => { pdfCalls.push({ kind: '940', ...x }); return Buffer.from('pdf'); },
  renderGenericDepositPdf: async (x: Row) => { pdfCalls.push({ kind: 'generic', ...x }); return Buffer.from('pdf'); },
}));

import { GET as basGET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';
import { GET as stpGET } from '@/app/api/v1/agentbook-payroll/au/stp/route';
import { GET as yearEndGET } from '@/app/api/v1/agentbook-payroll/year-end/route';
import { GET as yearEndPdfGET } from '@/app/api/v1/agentbook-payroll/year-end/pdf/route';
import { GET as depositPdfGET } from '@/app/api/v1/agentbook-payroll/tax-deposits/[id]/pdf/route';
import { POST as processPOST } from '@/app/api/v1/agentbook-payroll/pay-runs/[id]/process/route';

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
/** Date-only at UTC midnight (how @db.Date-style values arrive) — the case local-time math gets wrong west of UTC. */
const d0 = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
function addRun(id: string, periodEnd: string, payDate: string | null, gross: number, status = 'paid', at = d) {
  state.runs.push({ id, tenantId: 't1', status, periodStart: at(periodEnd), periodEnd: at(periodEnd), payDate: payDate ? at(payDate) : null });
  state.stubs.push({
    id: `s-${id}`, payRunId: id, tenantId: 't1', employeeId: 'e1', employeeName: 'Ann',
    grossCents: gross, netCents: gross * 0.75, federalTaxCents: gross * 0.2, stateTaxCents: 0, ficaCents: gross * 0.05,
    otherDeductCents: 0, sgCents: gross * 0.12,
  });
}
const get = (url: string) => new NextRequest(`http://x${url}`, { method: 'GET' });

beforeEach(() => {
  state.runs = []; state.stubs = []; state.deposits = []; state.journals = []; state.jurisdiction = 'au'; pdfCalls.length = 0;
  addRun('r0', '2026-06-30', '2026-07-02', 30_000);
  addRun('r3', '2026-09-15', null, 50_000);
  addRun('r1', '2026-09-30', '2026-10-03', 100_000);
  addRun('r2', '2026-12-31', '2027-01-02', 200_000);
});

describe('PR 4d: statutory reports bucket by payDate ?? periodEnd', () => {
  it('BAS W1/W2 per quarter follow the pay date (legacy run keeps periodEnd)', async () => {
    const bas = async (s: string, e: string) => (await (await basGET(get(`/bas?periodStart=${s}&periodEnd=${e}`))).json()).data;
    const q2 = await bas('2026-04-01', '2026-06-30');
    const q3 = await bas('2026-07-01', '2026-09-30');
    const q4 = await bas('2026-10-01', '2026-12-31');
    const q1 = await bas('2027-01-01', '2027-03-31');
    expect([q2.w1TotalWagesCents, q3.w1TotalWagesCents, q4.w1TotalWagesCents, q1.w1TotalWagesCents]).toEqual([0, 80_000, 100_000, 200_000]);
    expect([q2.w2PaygWithheldCents, q3.w2PaygWithheldCents, q4.w2PaygWithheldCents, q1.w2PaygWithheldCents]).toEqual([0, 16_000, 20_000, 40_000]);
  });

  it('STP: financial year and YTD follow the pay date', async () => {
    // r0 earned in FY2025-26 but paid 2 Jul 2026 → FY2026-27.
    const r0 = (await (await stpGET(get('/stp?payRunId=r0'))).json()).data;
    expect(r0.financialYear).toBe(2027);
    expect(r0.payees[0].ytdGrossCents).toBe(30_000);
    // r1 paid 3 Oct: YTD = r0 + r3 + r1 (r2 is paid later).
    const r1 = (await (await stpGET(get('/stp?payRunId=r1'))).json()).data;
    expect(r1.payees[0]).toMatchObject({ ytdGrossCents: 180_000, ytdPaygWithheldCents: 36_000, ytdSuperCents: 21_600 });
    expect(r1.payDate).toBe('2026-10-03');
    expect(r1.periodEnd).toBe('2026-09-30');
  });

  it('year-end forms: 2026 excludes the run paid 2 Jan 2027', async () => {
    const y26 = (await (await yearEndGET(get('/ye?year=2026'))).json()).data;
    const y27 = (await (await yearEndGET(get('/ye?year=2027'))).json()).data;
    expect(y26.forms[0].boxes.grossCents).toBe(180_000);
    expect(y26.reportingBasis).toBe('pay_date');
    expect(y27.forms[0].boxes.grossCents).toBe(200_000);
  });

  it('year-end PDF: same bucket as the year-end route', async () => {
    await yearEndPdfGET(get('/ye/pdf?year=2026&employeeId=e1'));
    await yearEndPdfGET(get('/ye/pdf?year=2027&employeeId=e1'));
    expect(pdfCalls.filter((c) => c.kind === 'w2').map((c) => c.boxes.grossCents)).toEqual([180_000, 200_000]);
  });

  it('tax-deposits PDF: 941 quarter and 940 year re-derive by pay date', async () => {
    state.deposits.push(
      { id: 'q3', tenantId: 't1', form: '941', periodLabel: '2026-Q3', amountCents: 1, dueDate: d('2026-10-31') },
      { id: 'q4', tenantId: 't1', form: '941', periodLabel: '2026-Q4', amountCents: 1, dueDate: d('2027-01-31') },
      { id: 'y27', tenantId: 't1', form: '940', periodLabel: '2027', amountCents: 1, dueDate: d('2028-01-31') },
    );
    for (const id of ['q3', 'q4', 'y27']) await depositPdfGET(get(`/dep/${id}/pdf`), { params: Promise.resolve({ id }) });
    expect(pdfCalls.map((c) => c.grossWagesCents)).toEqual([80_000, 100_000, 200_000]);
    expect(pdfCalls[1].breakdown).toEqual({ incomeTaxWithheldCents: 20_000, employeeFicaCents: 5_000, employerFicaCents: 5_000 });
  });

  it('processing: journal stays on periodEnd, deposits accrue to the pay-date quarter/year', async () => {
    state.jurisdiction = 'us';
    addRun('r9', '2026-12-31', '2027-01-02', 400_000, 'draft');
    const res = await processPOST(new NextRequest('http://x/p', { method: 'POST' }), { params: Promise.resolve({ id: 'r9' }) });
    expect(res.status).toBe(200);
    expect(state.journals).toHaveLength(1);
    expect(state.journals[0].date.toISOString()).toBe('2026-12-31T12:00:00.000Z'); // O1: earned period
    const labels = state.deposits.map((x) => `${x.form}:${x.periodLabel}`).sort();
    expect(labels).toEqual(['940:2027', '941:2027-Q1', 'sg:2027-Q1']); // stubs carry sgCents, so SG accrues too
  });

  it('processed-run snapshot: re-processing is refused and amounts never change — only bucketing does', async () => {
    const before = JSON.stringify(state.stubs.filter((s) => s.payRunId === 'r2'));
    const res = await processPOST(new NextRequest('http://x/p', { method: 'POST' }), { params: Promise.resolve({ id: 'r2' }) });
    expect(res.status).toBe(409);
    expect(state.journals).toHaveLength(0);
    expect(state.deposits).toHaveLength(0);
    expect(JSON.stringify(state.stubs.filter((s) => s.payRunId === 'r2'))).toBe(before);
    // The same untouched stub totals land in 2027 (paid 2 Jan), not 2026.
    const y27 = (await (await yearEndGET(get('/ye?year=2027'))).json()).data;
    expect(y27.forms[0].boxes.grossCents).toBe(200_000);
  });
});

describe('PR 4d review: UTC date-only boundaries hold west of UTC (TZ=America/Los_Angeles)', () => {
  const prevTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterAll(() => { process.env.TZ = prevTz; });

  it('the TZ really is LA (1 Jan 00:00Z is 31 Dec locally)', () => {
    expect(d0('2028-01-01').getDate()).toBe(31);
  });

  it('a run paid 1 Jan (UTC midnight) accrues 941/940/SG to the NEW year', async () => {
    state.jurisdiction = 'us';
    addRun('rj', '2027-12-31', '2028-01-01', 400_000, 'draft', d0);
    await processPOST(new NextRequest('http://x/p', { method: 'POST' }), { params: Promise.resolve({ id: 'rj' }) });
    expect(state.deposits.map((x) => `${x.form}:${x.periodLabel}`).sort()).toEqual(['940:2028', '941:2028-Q1', 'sg:2028-Q1']);
    expect(state.journals[0].date.toISOString()).toBe('2027-12-31T00:00:00.000Z');
  });

  it('31 Mar period paid 1 Apr: BAS Q2 and the 941 Q2 PDF, not Q1', async () => {
    addRun('ra', '2027-03-31', '2027-04-01', 70_000, 'paid', d0);
    const bas = async (s: string, e: string) => (await (await basGET(get(`/bas?periodStart=${s}&periodEnd=${e}`))).json()).data.w1TotalWagesCents;
    expect(await bas('2027-01-01', '2027-03-31')).toBe(200_000);
    expect(await bas('2027-04-01', '2027-06-30')).toBe(70_000);
    state.deposits.push({ id: 'q2', tenantId: 't1', form: '941', periodLabel: '2027-Q2', amountCents: 1, dueDate: d('2027-07-31') });
    await depositPdfGET(get('/dep/q2/pdf'), { params: Promise.resolve({ id: 'q2' }) });
    expect(pdfCalls.at(-1)!.grossWagesCents).toBe(70_000);
  });

  it('year-end: a 1 Jan 2028 payment is a 2028 form, not 2027', async () => {
    addRun('rj', '2027-12-31', '2028-01-01', 400_000, 'paid', d0);
    const y27 = (await (await yearEndGET(get('/ye?year=2027'))).json()).data;
    const y28 = (await (await yearEndGET(get('/ye?year=2028'))).json()).data;
    expect(y27.forms[0].boxes.grossCents).toBe(200_000);
    expect(y28.forms[0].boxes.grossCents).toBe(400_000);
  });
});

describe('PR 4d review: STP default target is the latest by pay date', () => {
  it('picks the run paid 2 Jan 2027 over a legacy run whose period ends later (1 Jan 2027)', async () => {
    addRun('rL', '2027-01-01', null, 10_000);
    const data = (await (await stpGET(get('/stp'))).json()).data;
    expect(data.payRunId).toBe('r2');
    expect(data.payDate).toBe('2027-01-02');
  });
});
