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

interface Overview { data: { cashToday: number; monthMtd: { netCents: number } | null; isBrandNew: boolean } }
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
