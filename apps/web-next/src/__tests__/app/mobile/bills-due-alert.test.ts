// @vitest-environment node
/**
 * PR 3d.2 — Home "N bills due": every unpaid (open | partial) bill inside the
 * alert window, amount = what is still owing; one bill keeps its own sentence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import type { MobileAlert, MobileHome } from '@/lib/mobile/types';
import { GET } from '@/app/api/v1/agentbook-core/mobile/home/route';
import { alertCopy } from '@/app/app/_lib/alert-copy';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { i18nT } from './test-utils';

const day = (s: string) => new Date(`${s}T12:00:00.000Z`);
const billAlert = async () => {
  const res = await GET(tenantReq('/api/v1/agentbook-core/mobile/home', 't1'));
  return (await json<{ data: MobileHome }>(res)).data.alerts.find((a) => a.kind === 'bill_due');
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const seed = fullSeed();
  seed.abBill = [
    ...seed.abBill,
    { id: 'b-part', tenantId: 't1', vendorName: 'Hydro', amountCents: 20000, paidCents: 12000, status: 'partial', postingMode: 'at_entry', deletedAt: null, dueDate: day('2026-06-22') },
  ];
  memDb.reset(seed);
});
afterEach(() => vi.useRealTimers());

describe('Home bills-due alert (open + partial)', () => {
  it('two unpaid bills due → one alert, count 2, amount = Σ outstanding (partial counts its remainder)', async () => {
    const a = await billAlert();
    expect(a).toMatchObject({ id: 'bill_due:many', severity: 'warn', params: { count: 2, days: 2, vendor: 'Hydro', amountCents: 150000 + 8000 } });
  });
  it('a lone partial bill keeps the single-bill sentence with its remainder', async () => {
    memDb.reset({ ...fullSeed(), abBill: [{ id: 'b-part', tenantId: 't1', vendorName: 'Hydro', amountCents: 20000, paidCents: 12000, status: 'partial', postingMode: 'at_entry', deletedAt: null, dueDate: day('2026-06-22') }] });
    const a = await billAlert();
    expect(a).toMatchObject({ id: 'bill_due:b-part', params: { vendor: 'Hydro', days: 2, amountCents: 8000 } });
    expect(a!.params).not.toHaveProperty('count');
  });
  it('copy in en / fr-CA / zh-CN', () => {
    const cad = (c: number) => formatCurrencyCents(c, 'CAD', 'en');
    const al: MobileAlert = { id: 'bill_due:many', kind: 'bill_due', severity: 'warn', params: { count: 2, days: 2, vendor: 'Hydro', amountCents: 158000 } };
    expect(alertCopy(al, i18nT('en'), cad).title).toBe('2 bills due — CA$1,580 still owing');
    expect(alertCopy(al, i18nT('fr-CA'), cad).title).toBe('2 factures à payer — CA$1,580 encore dus');
    expect(alertCopy(al, i18nT('zh-CN'), cad).title).toBe('2 张账单即将到期——仍欠 CA$1,580');
    expect(alertCopy({ ...al, params: { ...al.params, days: -3 } }, i18nT('en'), cad).title).toBe('2 bills due, the first is overdue — CA$1,580 still owing');
  });
});
