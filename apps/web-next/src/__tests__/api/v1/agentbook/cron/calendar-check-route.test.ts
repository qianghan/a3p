import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const abTenantConfigFindMany = vi.fn();
const abCalendarEventFindMany = vi.fn();
const abCalendarEventCreateMany = vi.fn();
const abCalendarEventUpdate = vi.fn();
const abEventCreate = vi.fn();
const reportError = vi.fn();
const createNotification = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findMany: (...a: unknown[]) => abTenantConfigFindMany(...a) },
    abCalendarEvent: {
      findMany: (...a: unknown[]) => abCalendarEventFindMany(...a),
      createMany: (...a: unknown[]) => abCalendarEventCreateMany(...a),
      update: (...a: unknown[]) => abCalendarEventUpdate(...a),
    },
    abEvent: { create: (...a: unknown[]) => abEventCreate(...a) },
  },
  Prisma: {},
}));
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/notifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/calendar-check/route';

beforeEach(() => {
  abTenantConfigFindMany.mockReset(); abCalendarEventFindMany.mockReset();
  abCalendarEventCreateMany.mockReset(); abCalendarEventUpdate.mockReset();
  abEventCreate.mockReset(); reportError.mockReset(); createNotification.mockReset();
  abTenantConfigFindMany.mockResolvedValue([]);
  abCalendarEventFindMany.mockResolvedValue([]);
  abCalendarEventCreateMany.mockResolvedValue({ count: 0 });
  abCalendarEventUpdate.mockResolvedValue({});
  abEventCreate.mockResolvedValue({});
  createNotification.mockResolvedValue({});
});

function req() {
  return new NextRequest('http://x/api/v1/agentbook/cron/calendar-check');
}

describe('GET /api/v1/agentbook/cron/calendar-check', () => {
  it('seeds AbCalendarEvent rows for every jurisdiction (us/ca/uk/au) without a schema-validation crash', async () => {
    abTenantConfigFindMany.mockResolvedValue([
      { userId: 'tenant-us', jurisdiction: 'us', region: 'us' },
      { userId: 'tenant-ca', jurisdiction: 'ca', region: 'ON' },
      { userId: 'tenant-uk', jurisdiction: 'uk', region: 'uk' },
      { userId: 'tenant-au', jurisdiction: 'au', region: 'au' },
    ]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.success).toBe(true);
    expect(j.tenantsSeeded).toBe(4);
    // No per-tenant seed failure should have been reported for any jurisdiction.
    expect(reportError).not.toHaveBeenCalled();
    // createMany was called with real, schema-shaped rows (titleKey + leadTimeDays
    // as an array + status), not the old drifted field names — this is exactly the
    // shape that used to throw a PrismaClientValidationError.
    expect(abCalendarEventCreateMany).toHaveBeenCalled();
    const firstCallRows = abCalendarEventCreateMany.mock.calls[0][0].data;
    expect(firstCallRows.length).toBeGreaterThan(0);
    for (const row of firstCallRows) {
      expect(row).toHaveProperty('titleKey');
      expect(row).toHaveProperty('status', 'upcoming');
      expect(Array.isArray(row.leadTimeDays)).toBe(true);
    }
  });

  it('an AU tenant seeds without error using the au jurisdiction pack', async () => {
    abTenantConfigFindMany.mockResolvedValue([{ userId: 'tenant-au', jurisdiction: 'au', region: 'au' }]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(reportError).not.toHaveBeenCalled();
    expect(abCalendarEventCreateMany).toHaveBeenCalled();
  });

  it('falls back to the us pack for an unrecognized jurisdiction rather than crashing', async () => {
    abTenantConfigFindMany.mockResolvedValue([{ userId: 'tenant-x', jurisdiction: 'not-a-real-jurisdiction', region: 'x' }]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('fires an alert and marks the event alerted for an upcoming tax_deadline event within the lead window', async () => {
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now
    abCalendarEventFindMany.mockResolvedValue([
      { id: 'evt-1', tenantId: 'tenant-1', eventType: 'tax_deadline', titleKey: 'calendar.bas_q1_due', date: soon, leadTimeDays: [7, 3, 1, 0], urgency: 'critical', actionUrl: null, actionLabelKey: null },
    ]);
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.alertsFired).toBe(1);
    expect(abCalendarEventUpdate).toHaveBeenCalledWith({ where: { id: 'evt-1' }, data: { status: 'alerted' } });
    expect(abEventCreate).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
  });

  it('does not fire an alert for an event outside its lead-time window', async () => {
    const farOut = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days out, lead window only covers last 1 day
    abCalendarEventFindMany.mockResolvedValue([
      { id: 'evt-2', tenantId: 'tenant-1', eventType: 'tax_deadline', titleKey: 'calendar.tpar_due', date: farOut, leadTimeDays: [1], urgency: 'important', actionUrl: null, actionLabelKey: null },
    ]);
    const r = await GET(req());
    const j = await r.json();
    expect(j.alertsFired).toBe(0);
    expect(abCalendarEventUpdate).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is set and the request lacks a matching bearer token', async () => {
    const prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    try {
      const r = await GET(req());
      expect(r.status).toBe(401);
    } finally {
      process.env.CRON_SECRET = prevSecret;
    }
  });
});
