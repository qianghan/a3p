import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const bankAccountFindMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abBankAccount: { findMany: (...a: unknown[]) => bankAccountFindMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const syncBasiqAccount = vi.fn();
vi.mock('@/lib/agentbook-basiq-sync', () => ({
  syncBasiqAccount: (...a: unknown[]) => syncBasiqAccount(...a),
}));

const sanitizeBasiqError = vi.fn((e: unknown) => ({ message: 'sanitized: ' + String(e) }));
vi.mock('@/lib/agentbook-basiq', () => ({
  sanitizeBasiqError: (...a: unknown[]) => sanitizeBasiqError(...a),
}));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/basiq-sync/route';

function req(bearer?: string) {
  return new NextRequest('http://x/cron/basiq-sync', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockResolvedValue({});
  bankAccountFindMany.mockResolvedValue([]);
  tenantConfigFindUnique.mockResolvedValue({ basiqUserId: 'basiq-user-1' });
});

describe('GET /cron/basiq-sync', () => {
  it('returns 401 when CRON_SECRET is set and the bearer token is missing', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req());
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('returns 401 when CRON_SECRET is set and the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req('wrong-secret'));
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('allows the request through when the bearer token matches CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req('real-secret'));
    expect(res.status).toBe(200);
    delete process.env.CRON_SECRET;
  });

  it('syncs every connected basiq account across tenants with bounded concurrency', async () => {
    bankAccountFindMany.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-1', lastSynced: null },
      { id: 'a2', tenantId: 'tenant-2', lastSynced: null },
    ]);
    syncBasiqAccount
      .mockResolvedValueOnce({ added: 2, modified: 0, removed: 0, hasMore: false })
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.accountsProcessed).toBe(2);
    expect(json.added).toBe(3);
    expect(json.errorCount).toBe(0);
    expect(bankAccountFindMany).toHaveBeenCalledWith({
      where: { provider: 'basiq', connected: true },
      select: { id: true, tenantId: true, lastSynced: true },
    });
    // one abEvent audit row per tenant
    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', eventType: 'bank.basiq_cron_sync_completed' }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-2', eventType: 'bank.basiq_cron_sync_completed' }),
      }),
    );
  });

  it("one tenant's account sync rejecting does not block another tenant's sync", async () => {
    bankAccountFindMany.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-fail', lastSynced: null },
      { id: 'a2', tenantId: 'tenant-ok', lastSynced: null },
    ]);
    syncBasiqAccount.mockImplementation(async (tenantId: string) => {
      if (tenantId === 'tenant-fail') throw new Error('basiq api down');
      return { added: 5, modified: 0, removed: 0, hasMore: false };
    });

    const res = await GET(req());
    const json = await res.json();

    expect(json.errorCount).toBe(1);
    expect(json.added).toBe(5);
    expect(reportError).toHaveBeenCalledTimes(1);

    // Both tenants get an audit row — the failing tenant's row records the
    // error count, the surviving tenant's row records its added count.
    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-fail',
          eventType: 'bank.basiq_cron_sync_completed',
          action: expect.objectContaining({ errors: 1 }),
        }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-ok',
          eventType: 'bank.basiq_cron_sync_completed',
          action: expect.objectContaining({ added: 5, errors: 0 }),
        }),
      }),
    );
    // The surviving tenant's result is present in the summary.
    expect(json.summary.transactionsImported).toBe(5);
  });

  it('records an error (without crashing) when a connected account has no basiqUserId configured', async () => {
    bankAccountFindMany.mockResolvedValue([{ id: 'a1', tenantId: 'tenant-orphan', lastSynced: null }]);
    tenantConfigFindUnique.mockResolvedValue(null);

    const res = await GET(req());
    const json = await res.json();

    expect(json.errorCount).toBe(1);
    expect(syncBasiqAccount).not.toHaveBeenCalled();
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-orphan', action: expect.objectContaining({ errors: 1 }) }),
      }),
    );
  });
});
