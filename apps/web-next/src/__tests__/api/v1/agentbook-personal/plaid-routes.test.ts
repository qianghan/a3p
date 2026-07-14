import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const requirePersonalInsightsAddon = vi.fn();
vi.mock('@/lib/agentbook-personal-insights/guard', () => ({
  requirePersonalInsightsAddon: (...a: unknown[]) => requirePersonalInsightsAddon(...a),
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const createLinkToken = vi.fn();
const exchangePublicToken = vi.fn();
const disconnectAccount = vi.fn();
const syncTransactionsForAccount = vi.fn();
const sanitizePlaidError = vi.fn((e: unknown) => 'sanitized: ' + String(e));
vi.mock('@/lib/agentbook-personal-plaid', () => ({
  createLinkToken: (...a: unknown[]) => createLinkToken(...a),
  exchangePublicToken: (...a: unknown[]) => exchangePublicToken(...a),
  disconnectAccount: (...a: unknown[]) => disconnectAccount(...a),
  syncTransactionsForAccount: (...a: unknown[]) => syncTransactionsForAccount(...a),
  sanitizePlaidError: (...a: unknown[]) => sanitizePlaidError(...a),
}));

const personalAccountFindMany = vi.fn();
const eventCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: { findMany: (...a: unknown[]) => personalAccountFindMany(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

function req(body?: unknown) {
  return new NextRequest('http://x/plaid', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePersonalInsightsAddon.mockResolvedValue({ tenantId: 'tenant-1' });
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  eventCreate.mockResolvedValue({});
});

describe('POST /agentbook-personal/plaid/link-token', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/link-token/route');
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it('returns the linkToken when entitled', async () => {
    createLinkToken.mockResolvedValue({ linkToken: 'link-abc', expiration: '2026-01-01' });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/link-token/route');
    const res = await POST(req());
    const json = await res.json();
    expect(json.data.linkToken).toBe('link-abc');
    expect(createLinkToken).toHaveBeenCalledWith('tenant-1');
  });
});

describe('POST /agentbook-personal/plaid/exchange', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({ publicToken: 'pub-1' }));
    expect(res.status).toBe(402);
    expect(exchangePublicToken).not.toHaveBeenCalled();
  });

  it('returns 400 when publicToken is missing', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('strips accessTokenEnc from the response', async () => {
    exchangePublicToken.mockResolvedValue([
      { id: 'a1', tenantId: 'tenant-1', accessTokenEnc: 'SECRET', name: 'Checking', balanceCents: 100 },
    ]);
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/exchange/route');
    const res = await POST(req({ publicToken: 'pub-1', institutionName: 'Chase' }));
    const json = await res.json();
    expect(json.data.accounts[0].accessTokenEnc).toBeUndefined();
    expect(json.data.accounts[0].name).toBe('Checking');
  });
});

describe('POST /agentbook-personal/plaid/disconnect', () => {
  it('is NOT gated by personal_insights — works even when requirePersonalInsightsAddon would deny', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/disconnect/route');
    const res = await POST(req({ accountId: 'a1' }));
    expect(res.status).toBe(200);
    expect(disconnectAccount).toHaveBeenCalledWith('a1', 'tenant-1');
    // Confirms this route never even calls the addon guard.
    expect(requirePersonalInsightsAddon).not.toHaveBeenCalled();
  });

  it('returns 400 when accountId is missing', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/disconnect/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});

describe('POST /agentbook-personal/plaid/sync', () => {
  it('returns 402 without the personal_insights add-on', async () => {
    requirePersonalInsightsAddon.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'upsell' }, { status: 402 }),
    });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/sync/route');
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(personalAccountFindMany).not.toHaveBeenCalled();
  });

  it('syncs every connected account and reports a summary', async () => {
    personalAccountFindMany.mockResolvedValue([{ id: 'a1', tenantId: 'tenant-1' }, { id: 'a2', tenantId: 'tenant-1' }]);
    syncTransactionsForAccount
      .mockResolvedValueOnce({ added: 3, modified: 0, removed: 0, cursor: 'c1', hasMore: false })
      .mockResolvedValueOnce({ added: 2, modified: 1, removed: 0, cursor: 'c2', hasMore: false });
    const { POST } = await import('@/app/api/v1/agentbook-personal/plaid/sync/route');
    const res = await POST(req());
    const json = await res.json();
    expect(json.data.accountsSynced).toBe(2);
    expect(json.data.transactionsImported).toBe(5);
    expect(json.data.complete).toBe(true);
  });
});
