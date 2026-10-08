// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import type { MobileHome } from '@/lib/mobile/types';
import { GET } from '@/app/api/v1/agentbook-core/mobile/home/route';
import { GET as PROACTIVE } from '@/app/api/v1/agentbook-expense/advisor/proactive-alerts/route';

const home = async (tenant = 't1') => {
  const res = await GET(tenantReq('/api/v1/agentbook-core/mobile/home', tenant));
  return { status: res.status, headers: res.headers, body: await json<{ success: boolean; data: MobileHome }>(res) };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('GET /mobile/home — alerts', () => {
  it('ranks alerts critical > warn > info and sends every one to a mobile destination', async () => {
    const { status, headers, body } = await home();
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(body.data.alerts.map((a) => a.kind)).toEqual(['invoice_overdue', 'bill_due', 'review_needed', 'receipts_missing', 'uncategorized']);
    expect(body.data.alerts[0]).toEqual({
      id: 'invoice_overdue:inv1', kind: 'invoice_overdue', severity: 'critical',
      params: { client: 'Acme', days: 19, amountCents: 150000, number: 'INV-1' },
      action: { type: 'post', endpoint: '/api/v1/agentbook-invoice/invoices/inv1/remind', labelKey: 'mobile.alerts.action_remind' },
    });
    expect(body.data.alerts[1]).toMatchObject({ severity: 'warn', params: { vendor: 'Rent Co', days: 4, amountCents: 150000 }, target: { route: '/app/chat', query: { topic: 'bill_due' } } });
    expect(body.data.alerts[2]).toMatchObject({ severity: 'warn', params: { count: 1, suggestions: 1 }, target: { route: '/app/docs', query: { filter: 'needs-review' } } });
    expect(body.data.alerts[3]).toMatchObject({ severity: 'info', params: { count: 2 }, target: { route: '/app/docs', query: { filter: 'no-receipt' } } });
    expect(body.data.alerts[4]).toMatchObject({ severity: 'info', params: { count: 2 }, target: { route: '/app/docs', query: { filter: 'no-category' } } });
  });

  it('a tax instalment within 14 days becomes a tax_deadline alert routed to chat', async () => {
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    const tax = (await home()).body.data.alerts.find((a) => a.kind === 'tax_deadline');
    expect(tax).toEqual({
      id: 'tax_deadline:tax:ca:2026:Q3', kind: 'tax_deadline', severity: 'warn',
      params: { days: 10, quarter: 3, year: 2026 },
      target: { route: '/app/chat', query: { topic: 'tax_deadline' } },
    });
  });

  it('≤3 days with NO known amount (no instalment row) stays warn: an unknown sum is not a firm critical obligation', async () => {
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    const tax = (await home()).body.data.alerts.find((a) => a.kind === 'tax_deadline');
    expect(tax).toMatchObject({ severity: 'warn', params: { days: 2, quarter: 3, year: 2026 } });
    expect(tax?.params).not.toHaveProperty('amountCents');
  });

  it('≤3 days WITH a known amount is critical; 4+ days with an amount is warn', async () => {
    memDb.table('abQuarterlyPayment').rows.push({
      id: 'q-ca-3', tenantId: 't1', year: 2026, quarter: 3, jurisdiction: 'ca', amountDueCents: 300000, amountPaidCents: 0, deadline: new Date('2026-09-15T00:00:00.000Z'),
    });
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    expect((await home()).body.data.alerts.find((a) => a.kind === 'tax_deadline')).toMatchObject({ severity: 'critical', params: { days: 2, amountCents: 300000 } });
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    expect((await home()).body.data.alerts.find((a) => a.kind === 'tax_deadline')).toMatchObject({ severity: 'warn', params: { days: 5, amountCents: 300000 } });
  });

  it('a jurisdiction without an instalment schedule (uk) gets no tax_deadline alert and no instalment in nextUp', async () => {
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    memDb.table('abTenantConfig').rows[0].jurisdiction = 'uk';
    const { status, body } = await home();
    expect(status).toBe(200);
    expect(body.data.alerts.find((a) => a.kind === 'tax_deadline')).toBeUndefined();
    expect(body.data.nextUp.filter((u) => u.kind === 'tax')).toEqual([]);
  });

  it('a rejecting suggestion lookup (abUserMemory) still returns 200 with a suggestion count of 0', async () => {
    vi.spyOn(memDb.table('abUserMemory'), 'findUnique').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, body } = await home();
    expect(status).toBe(200);
    expect(body.data.alerts.find((a) => a.kind === 'review_needed')?.params).toEqual({ count: 1, suggestions: 0 });
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('receipts_missing uses the same definition as proactive-alerts', async () => {
    const receipts = (await home()).body.data.alerts.find((a) => a.kind === 'receipts_missing');
    const proactive = await json<{ data: { alerts: Array<{ id: string; title: string }> } }>(
      await PROACTIVE(tenantReq('/api/v1/agentbook-expense/advisor/proactive-alerts', 't1')),
    );
    expect(proactive.data.alerts.find((a) => a.id === 'missing-receipts')?.title).toBe(`${receipts?.params.count} receipts missing`);
  });
});

describe('GET /mobile/home — KPIs, next up, recent', () => {
  it('returns the tenant currency, KPIs, next 3 deadlines and last 5 activity items', async () => {
    const { body } = await home();
    expect(body.data.currency).toBe('CAD');
    expect(body.data.generatedAt).toBe(NOW.toISOString());
    expect(body.data.isBrandNew).toBe(false);
    expect(body.data.kpis).toMatchObject({ monthNetCents: -5400, cashTodayCents: 460100, outstandingCents: 200000, overdueCount: 1, overdueCents: 150000 });
    expect(typeof body.data.kpis.estTaxOwedCents).toBe('number');
    expect(body.data.nextUp.map((u) => u.id)).toEqual(['bill:b1', 'cal:ce1']);
    expect(body.data.recent.map((r) => r.id)).toEqual(['expense:e5', 'expense:e6', 'expense:e2', 'payment:pay1', 'invoice:inv2']);
    expect(body.data.recent[0]).toEqual({ id: 'expense:e5', kind: 'expense', label: 'Cafe', amountCents: 3500, at: '2026-06-18T00:00:00.000Z', docId: 'e5' });
    expect(body.data.recent[1].label).toBe('Bank transfer');
    expect(body.data.recent[3]).toMatchObject({ kind: 'payment', label: 'INV-1 · Acme', amountCents: 30000 });
    expect(body.data.recent[4]).toMatchObject({ kind: 'invoice', label: 'INV-2 · Beta', amountCents: 50000 });
  });

  it('a jurisdiction the engine does not model gets no tax estimate (never a silent US one)', async () => {
    memDb.table('abTenantConfig').rows[0].jurisdiction = 'uk';
    expect((await home()).body.data.kpis.estTaxOwedCents).toBeNull();
  });

  it('a brand-new tenant gets a truthful empty home', async () => {
    const { body } = await home('t3');
    // No cash/bank account at all → no cash figure (null, "Connect a bank account…"), not $0.
    expect(body.data).toMatchObject({
      currency: 'USD', isBrandNew: true, alerts: [], nextUp: [], recent: [],
      kpis: { monthNetCents: null, cashTodayCents: null, outstandingCents: 0, overdueCount: 0, overdueCents: 0, estTaxOwedCents: 0 },
    });
  });

  it('is tenant-scoped', async () => {
    const { body } = await home('t2');
    expect(body.data.recent.map((r) => r.id)).toEqual(['payment:pay-x', 'expense:x1', 'invoice:inv-x']);
    expect(body.data.alerts.filter((a) => a.kind === 'invoice_overdue').map((a) => a.id)).toEqual(['invoice_overdue:inv-x']);
    expect(body.data.kpis.outstandingCents).toBe(999000);
    expect(body.data.currency).toBe('USD');
  });

  it('401 without a session', async () => {
    expect((await home('none')).status).toBe(401);
  });
});
