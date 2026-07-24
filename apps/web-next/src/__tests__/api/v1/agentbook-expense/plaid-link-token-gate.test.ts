import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const requireBankConnectionQuota = vi.fn();
const createLinkToken = vi.fn();

vi.mock('@/lib/agentbook-bank/guard', () => ({
  requireBankConnectionQuota: (...a: unknown[]) => requireBankConnectionQuota(...a),
}));
vi.mock('@/lib/agentbook-plaid', () => ({
  createLinkToken: (...a: unknown[]) => createLinkToken(...a),
  sanitizePlaidError: (e: unknown) => String(e),
}));

import { POST } from '@/app/api/v1/agentbook-expense/plaid/link-token/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-expense/plaid/link-token', { method: 'POST' });
}

beforeEach(() => {
  requireBankConnectionQuota.mockReset();
  createLinkToken.mockReset();
});

describe('POST /agentbook-expense/plaid/link-token — paid gate', () => {
  it('blocks a free tenant (402 from the guard) and NEVER mints a link token', async () => {
    requireBankConnectionQuota.mockResolvedValue({
      response: NextResponse.json({ success: false, error: 'Bank sync is a paid feature.', upgradeUrl: '/billing' }, { status: 402 }),
    });
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(createLinkToken).not.toHaveBeenCalled();
  });

  it('mints a link token when the guard passes (paid tenant)', async () => {
    requireBankConnectionQuota.mockResolvedValue({ tenantId: 't1' });
    createLinkToken.mockResolvedValue({ linkToken: 'link-sandbox-abc', expiration: '2026-01-01' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.linkToken).toBe('link-sandbox-abc');
    expect(createLinkToken).toHaveBeenCalledWith('t1');
  });
});
