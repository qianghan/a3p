// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { missingReceiptWhere, rankAlerts, isMobileRoute, MISSING_RECEIPT_WINDOW_DAYS, MAX_ALERTS } from '@/lib/mobile/alerts';
import type { MobileAlert } from '@/lib/mobile/types';
import { GET as proactiveGET } from '@/app/api/v1/agentbook-expense/advisor/proactive-alerts/route';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

const missingIds = async (tenant: string) =>
  (await memDb.table('abExpense').findMany({ where: missingReceiptWhere(tenant, NOW) as Record<string, unknown> }))
    .map((r) => r.id as string)
    .sort();

describe('missingReceiptWhere — the single "missing receipt" definition', () => {
  it('confirmed business expenses over $25, last 90 days, no receipt, not skipped/archived/deleted', async () => {
    expect(MISSING_RECEIPT_WINDOW_DAYS).toBe(90);
    // e1 (receiptStatus 'pending') and e4 (receiptStatus NULL). Not e6 (skipped), not e7 (archived).
    expect(await missingIds('t1')).toEqual(['e1', 'e4']);
    expect(await missingIds('t2')).toEqual(['x1']);
  });

  it('keeps NULL receiptStatus rows (SQL-null-safe) and applies every boundary', async () => {
    const add = (o: Row) =>
      memDb.table('abExpense').rows.push({
        tenantId: 't1', isPersonal: false, status: 'confirmed', receiptUrl: null, receiptStatus: null,
        deletedAt: null, archivedAt: null, amountCents: 5000, date: new Date('2026-06-01T00:00:00.000Z'), ...o,
      });
    add({ id: 'null-status' });
    add({ id: 'is-2500', amountCents: 2500 });
    add({ id: 'is-2501', amountCents: 2501 });
    add({ id: 'too-old', date: new Date(NOW.getTime() - 91 * 86_400_000) });
    add({ id: 'deleted', deletedAt: NOW });
    add({ id: 'pending', status: 'pending_review' });
    add({ id: 'personal', isPersonal: true });
    add({ id: 'has-receipt', receiptUrl: 'https://blob.test/x.jpg' });
    expect(await missingIds('t1')).toEqual(['e1', 'e4', 'is-2501', 'null-status']);
  });
});

describe('rankAlerts', () => {
  const a = (id: string, severity: 'critical' | 'warn' | 'info', route = '/app/docs') =>
    ({ id, kind: 'uncategorized', severity, params: {}, target: { route } }) as MobileAlert;

  it('orders critical > warn > info, stable within a severity, capped at 5', () => {
    const out = rankAlerts([a('i1', 'info'), a('w1', 'warn'), a('c1', 'critical'), a('w2', 'warn'), a('i2', 'info'), a('c2', 'critical')]);
    expect(out.map((x) => x.id)).toEqual(['c1', 'c2', 'w1', 'w2', 'i1']);
    expect(MAX_ALERTS).toBe(5);
  });

  it('drops any alert that would send a phone user to a non-mobile page', () => {
    expect(rankAlerts([a('desk', 'critical', '/agentbook/expenses'), a('ok', 'info')]).map((x) => x.id)).toEqual(['ok']);
    expect(isMobileRoute('/app')).toBe(true);
    expect(isMobileRoute('/app/docs/abc')).toBe(true);
    expect(isMobileRoute('/agentbook')).toBe(false);
    expect(isMobileRoute('/application')).toBe(false);
  });

  it('keeps action-only alerts (no target)', () => {
    const remind = { id: 'r', kind: 'invoice_overdue', severity: 'critical', params: {}, action: { type: 'post', endpoint: '/api/v1/agentbook-invoice/invoices/x/remind', labelKey: 'mobile.alerts.action_remind' } } as MobileAlert;
    expect(rankAlerts([remind])).toEqual([remind]);
  });
});

describe('proactive-alerts reads the same definition', () => {
  it('reports 2 missing receipts (shared rule), not the old 30-day/no-skip count of 3', async () => {
    const body = await json<{ data: { alerts: Array<{ id: string; title: string }> } }>(
      await proactiveGET(tenantReq('/api/v1/agentbook-expense/advisor/proactive-alerts', 't1')),
    );
    expect(body.data.alerts.find((x) => x.id === 'missing-receipts')?.title).toBe('2 receipts missing');
  });
});
