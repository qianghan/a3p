import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const personalAccountFindMany = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: { findMany: (...a: unknown[]) => personalAccountFindMany(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const syncTransactionsForAccount = vi.fn();
const sanitizePlaidError = vi.fn((e: unknown) => 'sanitized: ' + String(e));
vi.mock('@/lib/agentbook-personal-plaid', () => ({
  syncTransactionsForAccount: (...a: unknown[]) => syncTransactionsForAccount(...a),
  sanitizePlaidError: (...a: unknown[]) => sanitizePlaidError(...a),
}));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { GET } from '@/app/api/v1/agentbook/cron/personal-plaid-sync/route';

function req(bearer?: string) {
  return new NextRequest('http://x/cron/personal-plaid-sync', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockResolvedValue({});
  personalAccountFindMany.mockResolvedValue([]);
});

describe('GET /cron/personal-plaid-sync', () => {
  it('returns 401 when CRON_SECRET is set and the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const res = await GET(req('wrong-secret'));
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it('syncs every connected account across tenants with bounded concurrency', async () => {
    personalAccountFindMany.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-1' },
      { id: 'a2', tenantId: 'tenant-2' },
    ]);
    syncTransactionsForAccount
      .mockResolvedValueOnce({ added: 2, modified: 0, removed: 0, cursor: 'c1', hasMore: false })
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, cursor: 'c2', hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.accountsProcessed).toBe(2);
    expect(json.added).toBe(3);
    expect(personalAccountFindMany).toHaveBeenCalledWith({
      where: { connected: true, accessTokenEnc: { not: null } },
      select: { id: true, tenantId: true },
    });
  });

  it('logs a per-account error without aborting the rest of the batch', async () => {
    personalAccountFindMany.mockResolvedValue([{ id: 'a1', tenantId: 'tenant-1' }, { id: 'a2', tenantId: 'tenant-2' }]);
    syncTransactionsForAccount
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, cursor: 'c2', hasMore: false });

    const res = await GET(req());
    const json = await res.json();

    expect(json.errorCount).toBe(1);
    expect(json.added).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
