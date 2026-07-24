import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const safeResolveAgentbookTenant = vi.fn();
const checkQuota = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));
vi.mock('@naap/billing', () => ({
  checkQuota: (...a: unknown[]) => checkQuota(...a),
}));

import { requireBankConnectionQuota } from '@/lib/agentbook-bank/guard';
import { NextResponse } from 'next/server';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-expense/plaid/link-token', { method: 'POST' });
}

beforeEach(() => {
  safeResolveAgentbookTenant.mockReset();
  checkQuota.mockReset();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 't1' });
});

describe('requireBankConnectionQuota', () => {
  it('passes through the tenantId when the plan allows bank connections (Pro/Business)', async () => {
    checkQuota.mockResolvedValue({ allowed: true, used: 0, limit: 3, remaining: 3 });
    const r = await requireBankConnectionQuota(req());
    expect(r).toEqual({ tenantId: 't1' });
    expect(checkQuota).toHaveBeenCalledWith('t1', 'bank_connections');
  });

  it('returns 402 + upgrade for a Free tenant (bank_connections quota 0)', async () => {
    checkQuota.mockResolvedValue({ allowed: false, used: 0, limit: 0, remaining: 0, reason: 'quota_exceeded' });
    const r = await requireBankConnectionQuota(req());
    expect('response' in r).toBe(true);
    const res = (r as { response: NextResponse }).response;
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.upgradeUrl).toBe('/billing');
    expect(body.error).toMatch(/paid feature/i);
  });

  it('returns 503 (not 402) when the quota check is unavailable (fail-closed, retryable)', async () => {
    checkQuota.mockResolvedValue({ allowed: false, retryable: true, used: 0, limit: 0, remaining: 0 });
    const r = await requireBankConnectionQuota(req());
    const res = (r as { response: NextResponse }).response;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/try again/i);
  });

  it('propagates the auth response when tenant resolution fails', async () => {
    const unauth = NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    safeResolveAgentbookTenant.mockResolvedValue({ response: unauth });
    const r = await requireBankConnectionQuota(req());
    expect((r as { response: NextResponse }).response.status).toBe(401);
    expect(checkQuota).not.toHaveBeenCalled();
  });
});
