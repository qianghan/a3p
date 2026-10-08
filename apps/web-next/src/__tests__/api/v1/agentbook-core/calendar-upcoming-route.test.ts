// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import type { UpcomingItem } from '@/lib/mobile/types';
import { GET } from '@/app/api/v1/agentbook-core/calendar/upcoming/route';

const NOW_U = new Date('2026-06-01T12:00:00.000Z');
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const upcoming = async (qs = '', tenant = 't1') => {
  const res = await GET(tenantReq(`/api/v1/agentbook-core/calendar/upcoming${qs}`, tenant));
  return { status: res.status, body: await json<{ success: boolean; data: { items: UpcomingItem[] } }>(res) };
};
const ids = async (qs = '', tenant = 't1') => (await upcoming(qs, tenant)).body.data.items.map((i) => i.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_U);
  memDb.reset({
    abTenantConfig: [
      { id: 'c1', userId: 't1', jurisdiction: 'us', currency: 'USD' },
      { id: 'c2', userId: 't2', jurisdiction: 'au', currency: 'AUD' },
    ],
    abQuarterlyPayment: [
      { id: 'q-us-2', tenantId: 't1', year: 2026, quarter: 2, jurisdiction: 'us', amountDueCents: 300000, amountPaidCents: 100000, deadline: day('2026-06-15') },
    ],
    abCalendarEvent: [
      { id: 'ev1', tenantId: 't1', eventType: 'renewal', titleKey: 'calendar.domain_renewal', date: day('2026-06-10'), status: 'upcoming' },
      { id: 'ev2', tenantId: 't1', eventType: 'renewal', titleKey: 'calendar.done', date: day('2026-06-11'), status: 'acted_on' },
      { id: 'ev3', tenantId: 't1', eventType: 'tax_deadline', titleKey: 'calendar.q2_estimated_tax', date: day('2026-06-15'), status: 'upcoming' },
      { id: 'ev4', tenantId: 't1', eventType: 'renewal', titleKey: 'calendar.snoozed', date: day('2026-07-15'), status: 'snoozed' },
      { id: 'evx', tenantId: 't2', eventType: 'renewal', titleKey: 'calendar.other', date: day('2026-06-05'), status: 'upcoming' },
    ],
    abBill: [
      { id: 'b1', tenantId: 't1', vendorName: 'Rent Co', amountCents: 150000, status: 'open', dueDate: day('2026-06-20') },
      { id: 'b2', tenantId: 't1', vendorName: 'Paid Co', amountCents: 100, status: 'paid', dueDate: day('2026-06-08') },
      { id: 'b3', tenantId: 't1', vendorName: 'Late Co', amountCents: 100, status: 'open', dueDate: day('2026-05-25') },
      { id: 'bx', tenantId: 't2', vendorName: 'Other', amountCents: 1, status: 'open', dueDate: day('2026-06-09') },
    ],
  });
});
afterEach(() => vi.useRealTimers());

describe('GET /calendar/upcoming', () => {
  it('merges calendar events, tax instalments and open bills, sorted by date (default 30 days)', async () => {
    const { status, body } = await upcoming();
    expect(status).toBe(200);
    expect(body.data.items).toEqual([
      { id: 'cal:ev1', kind: 'calendar', titleKey: 'calendar.domain_renewal', params: {}, date: '2026-06-10', daysAway: 9, amountCents: null },
      { id: 'tax:us:2026:Q2', kind: 'tax', titleKey: 'mobile.upcoming.tax_instalment', params: { quarter: 2, year: 2026 }, date: '2026-06-15', daysAway: 14, amountCents: 200000 },
      { id: 'bill:b1', kind: 'bill', titleKey: 'mobile.upcoming.bill_due', params: { vendor: 'Rent Co' }, date: '2026-06-20', daysAway: 19, amountCents: 150000 },
    ]);
  });

  it('honours the days window', async () => {
    expect(await ids('?days=10')).toEqual(['cal:ev1']);
    expect(await ids('?days=60')).toEqual(['cal:ev1', 'tax:us:2026:Q2', 'bill:b1', 'cal:ev4']);
  });

  it('drops a paid-in-full instalment and still de-duplicates its calendar twin', async () => {
    memDb.table('abQuarterlyPayment').rows[0].amountPaidCents = 300000;
    expect(await ids()).toEqual(['cal:ev1', 'bill:b1']);
  });

  it('falls back to the jurisdiction schedule (no amount) when no instalment row exists — and never writes one', async () => {
    memDb.table('abQuarterlyPayment').rows = [];
    const tax = (await upcoming()).body.data.items.find((i) => i.kind === 'tax');
    expect(tax).toMatchObject({ id: 'tax:us:2026:Q2', amountCents: null, daysAway: 14 });
    expect(memDb.table('abQuarterlyPayment').writes).toEqual([]);
  });

  it('AU: the July instalment of the previous financial year is found', async () => {
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    expect((await upcoming('', 't2')).body.data.items).toEqual([
      { id: 'tax:au:2025:Q4', kind: 'tax', titleKey: 'mobile.upcoming.tax_instalment', params: { quarter: 4, year: 2025 }, date: '2026-07-28', daysAway: 18, amountCents: null },
    ]);
  });

  it('is tenant-scoped', async () => {
    expect(await ids('', 't2')).toEqual(['cal:evx', 'bill:bx']);
  });

  it('validates days (1..90 integer) and requires a session', async () => {
    for (const bad of ['0', '91', 'abc', '1.5']) {
      expect((await upcoming(`?days=${bad}`)).status, bad).toBe(400);
    }
    expect((await upcoming('', 'none')).status).toBe(401);
  });
});
