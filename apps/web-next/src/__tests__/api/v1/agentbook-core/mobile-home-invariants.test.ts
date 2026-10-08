// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import type { MobileHome } from '@/lib/mobile/types';
import { GET as HOME } from '@/app/api/v1/agentbook-core/mobile/home/route';
import { GET as OVERVIEW } from '@/app/api/v1/agentbook-core/dashboard/overview/route';
import { GET as AGING } from '@/app/api/v1/agentbook-invoice/aging-report/route';
import { GET as ESTIMATE } from '@/app/api/v1/agentbook-tax/tax/estimate/route';

interface Overview { data: { cashToday: number | null; monthMtd: { netCents: number } | null; isBrandNew: boolean } }
interface Aging { data: { buckets: Record<string, unknown[]>; totals: Record<string, number>; totalOutstandingCents: number } }
interface Estimate { data: { amountOwedCents: number } }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

const cases = [
  ['t1', NOW], ['t2', NOW], ['t3', NOW],
  ['t1', new Date('2026-09-05T12:00:00.000Z')], ['t2', new Date('2026-12-31T23:00:00.000Z')],
] as const;

describe('mobile/home KPIs equal the existing endpoints (one definition per number)', () => {
  it.each(cases)('tenant %s at %s', async (tenant, at) => {
    vi.setSystemTime(at);
    const home = (await json<{ data: MobileHome }>(await HOME(tenantReq('/api/v1/agentbook-core/mobile/home', tenant)))).data;
    const overview = await json<Overview>(await OVERVIEW(tenantReq('/api/v1/agentbook-core/dashboard/overview', tenant)));
    const aging = await json<Aging>(await AGING(tenantReq('/api/v1/agentbook-invoice/aging-report', tenant)));
    const estimate = await json<Estimate>(await ESTIMATE(tenantReq('/api/v1/agentbook-tax/tax/estimate', tenant)));

    expect(home.kpis.cashTodayCents).toBe(overview.data.cashToday);
    expect(home.kpis.monthNetCents).toBe(overview.data.monthMtd ? overview.data.monthMtd.netCents : null);
    expect(home.isBrandNew).toBe(overview.data.isBrandNew);
    expect(home.kpis.outstandingCents).toBe(aging.data.totalOutstandingCents);
    const overdue = Object.entries(aging.data.buckets).filter(([b]) => b !== 'current');
    expect(home.kpis.overdueCount).toBe(overdue.reduce((n, [, list]) => n + list.length, 0));
    expect(home.kpis.overdueCents).toBe(
      Object.entries(aging.data.totals).filter(([b]) => b !== 'current').reduce((s, [, v]) => s + v, 0),
    );
    expect(home.kpis.estTaxOwedCents).toBe(estimate.data.amountOwedCents);
  });

  it('archiving an expense moves no KPI (archive files a doc away, it does not delete it)', async () => {
    vi.setSystemTime(NOW);
    const kpis = async () =>
      (await json<{ data: MobileHome }>(await HOME(tenantReq('/api/v1/agentbook-core/mobile/home', 't1')))).data.kpis;
    const seeded = await kpis(); // e7 (June, 9900) is archived in the fixture
    const expenses = memDb.table('abExpense').rows;
    for (const e of expenses) if (e.tenantId === 't1') e.archivedAt = e.id === 'e7' ? null : new Date('2026-06-19T09:00:00.000Z');
    expect(await kpis()).toEqual(seeded);
  });

  it.each(cases)('no alert from tenant %s at %s targets a desktop page', async (tenant, at) => {
    vi.setSystemTime(at);
    const home = (await json<{ data: MobileHome }>(await HOME(tenantReq('/api/v1/agentbook-core/mobile/home', tenant)))).data;
    expect(home.alerts.length).toBeLessThanOrEqual(5);
    for (const alert of home.alerts) {
      if (alert.target) {
        expect(alert.target.route.startsWith('/agentbook')).toBe(false);
        expect(alert.target.route === '/app' || alert.target.route.startsWith('/app/')).toBe(true);
      }
      if (alert.action) expect(alert.action.endpoint.startsWith('/api/v1/')).toBe(true);
      expect(alert.target || alert.action).toBeTruthy();
    }
  });
});

/**
 * Soft-deleted rows (expense e8, June 20000; invoice inv4, 400000 sent and 36
 * days overdue) move no number on the desktop endpoints OR on mobile/home.
 * Each test also revives the row to prove the fixture WOULD move the number
 * if live, so the exclusion is down to `deletedAt`, not a dead fixture.
 * Archived rows (e7, June 9900) still count.
 */
describe('soft-deleted rows move no number; archived rows still do', () => {
  const getHome = async () =>
    (await json<{ data: MobileHome }>(await HOME(tenantReq('/api/v1/agentbook-core/mobile/home', 't1')))).data;
  const getOverview = async () =>
    json<{ data: { monthMtd: { revenueCents: number; expenseCents: number; netCents: number } | null } }>(
      await OVERVIEW(tenantReq('/api/v1/agentbook-core/dashboard/overview', 't1')),
    );
  const getAging = async () => json<Aging>(await AGING(tenantReq('/api/v1/agentbook-invoice/aging-report', 't1')));
  const row = (model: string, id: string) => {
    const r = memDb.table(model).rows.find((x) => x.id === id);
    if (!r) throw new Error(`fixture ${model}:${id} missing`);
    return r;
  };

  beforeEach(() => vi.setSystemTime(NOW));

  it('(a) month net excludes the soft-deleted expense on overview AND mobile/home', async () => {
    expect(row('abExpense', 'e8').deletedAt).toBeInstanceOf(Date);
    expect((await getOverview()).data.monthMtd).toEqual({ revenueCents: 30000, expenseCents: 35400, netCents: -5400 });
    expect((await getHome()).kpis.monthNetCents).toBe(-5400);

    row('abExpense', 'e8').deletedAt = null; // live again → it counts
    expect((await getOverview()).data.monthMtd?.netCents).toBe(-25400);
    expect((await getHome()).kpis.monthNetCents).toBe(-25400);
  });

  it('(b) outstanding / overdue exclude the soft-deleted invoice on aging AND mobile/home, with no alert for it', async () => {
    expect(row('abInvoice', 'inv4').deletedAt).toBeInstanceOf(Date);
    const aging = (await getAging()).data;
    expect(aging.totalOutstandingCents).toBe(200000);
    expect(Object.values(aging.buckets).flat().map((e) => (e as { invoiceId: string }).invoiceId)).not.toContain('inv4');
    const home = await getHome();
    expect(home.kpis).toMatchObject({ outstandingCents: 200000, overdueCount: 1, overdueCents: 150000 });
    expect(home.alerts.filter((a) => a.kind === 'invoice_overdue').map((a) => a.id)).toEqual(['invoice_overdue:inv1']);
    expect(home.recent.map((r) => r.id)).not.toContain('invoice:inv4');

    row('abInvoice', 'inv4').deletedAt = null; // live again → it counts and leads the alerts
    expect((await getAging()).data.totalOutstandingCents).toBe(600000);
    const revived = await getHome();
    expect(revived.kpis).toMatchObject({ outstandingCents: 600000, overdueCount: 2, overdueCents: 550000 });
    expect(revived.alerts[0].id).toBe('invoice_overdue:inv4');
  });

  it('(c) archived expenses still count in month net on overview AND mobile/home', async () => {
    expect(row('abExpense', 'e7').archivedAt).toBeInstanceOf(Date);
    const before = { overview: (await getOverview()).data.monthMtd?.netCents, home: (await getHome()).kpis.monthNetCents };
    row('abExpense', 'e7').deletedAt = new Date('2026-06-19T12:00:00.000Z'); // deleting it (not archiving) removes 9900
    expect((await getOverview()).data.monthMtd?.netCents).toBe((before.overview as number) + 9900);
    expect((await getHome()).kpis.monthNetCents).toBe((before.home as number) + 9900);
  });

  it('recent never lists archived or soft-deleted rows, even when they are the newest', async () => {
    const ids = (await getHome()).recent.map((r) => r.id);
    expect(ids).not.toContain('expense:e7');
    expect(ids).not.toContain('expense:e8');
    expect(ids).not.toContain('invoice:inv4');
    row('abExpense', 'e7').archivedAt = null;
    row('abExpense', 'e8').deletedAt = null;
    row('abInvoice', 'inv4').deletedAt = null;
    expect((await getHome()).recent.slice(0, 3).map((r) => r.id)).toEqual(['invoice:inv4', 'expense:e8', 'expense:e7']);
  });
});
