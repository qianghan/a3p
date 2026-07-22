import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const personalAccountFindMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: { findMany: (...a: unknown[]) => personalAccountFindMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const syncPersonalBasiqAccount = vi.fn();
vi.mock('@/lib/agentbook-personal-basiq-sync', () => ({
  syncPersonalBasiqAccount: (...a: unknown[]) => syncPersonalBasiqAccount(...a),
}));

const sanitizeBasiqError = vi.fn((e: unknown) => ({ message: 'sanitized: ' + String(e) }));
vi.mock('@/lib/agentbook-basiq', () => ({
  sanitizeBasiqError: (...a: unknown[]) => sanitizeBasiqError(...a),
}));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/personal-basiq-sync/route';

function req(bearer?: string) {
  return new NextRequest('http://x/cron/personal-basiq-sync', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockResolvedValue({});
  personalAccountFindMany.mockResolvedValue([]);
  tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
});

describe('GET /cron/personal-basiq-sync', () => {
  it('returns 401 when CRON_SECRET is set and the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req('wrong-secret'));
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('syncs every connected basiq personal account across tenants with bounded concurrency', async () => {
    personalAccountFindMany.mockResolvedValue([
      { id: 'p1', tenantId: 'tenant-1', lastSynced: null },
      { id: 'p2', tenantId: 'tenant-2', lastSynced: null },
    ]);
    syncPersonalBasiqAccount
      .mockResolvedValueOnce({ added: 2, modified: 0, removed: 0, hasMore: false })
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.accountsProcessed).toBe(2);
    expect(json.added).toBe(3);
    expect(personalAccountFindMany).toHaveBeenCalledWith({
      where: { provider: 'basiq', connected: true },
      select: { id: true, tenantId: true, lastSynced: true },
    });
    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', eventType: 'personal.basiq_cron_sync_completed' }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-2', eventType: 'personal.basiq_cron_sync_completed' }),
      }),
    );
  });

  it("one tenant's account sync rejecting does not block another tenant's sync", async () => {
    personalAccountFindMany.mockResolvedValue([
      { id: 'p1', tenantId: 'tenant-fail', lastSynced: null },
      { id: 'p2', tenantId: 'tenant-ok', lastSynced: null },
    ]);
    syncPersonalBasiqAccount.mockImplementation(async (tenantId: string) => {
      if (tenantId === 'tenant-fail') throw new Error('basiq api down');
      return { added: 4, modified: 0, removed: 0, hasMore: false };
    });

    const res = await GET(req());
    const json = await res.json();

    expect(json.errorCount).toBe(1);
    expect(json.added).toBe(4);
    expect(reportError).toHaveBeenCalledTimes(1);

    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-fail',
          eventType: 'personal.basiq_cron_sync_completed',
          action: expect.objectContaining({ errors: 1 }),
        }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-ok',
          eventType: 'personal.basiq_cron_sync_completed',
          action: expect.objectContaining({ added: 4, errors: 0 }),
        }),
      }),
    );
    expect(json.summary.transactionsImported).toBe(4);
  });
});
