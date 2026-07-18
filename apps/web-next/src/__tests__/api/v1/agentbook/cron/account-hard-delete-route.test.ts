import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const hardDeleteScheduledAccounts = vi.fn();
vi.mock('@/lib/agentbook-account-hard-delete', () => ({
  hardDeleteScheduledAccounts: (...args: unknown[]) => hardDeleteScheduledAccounts(...args),
}));

import { GET } from '@/app/api/v1/agentbook/cron/account-hard-delete/route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook/cron/account-hard-delete', { headers });
}

beforeEach(() => {
  hardDeleteScheduledAccounts.mockReset();
  delete process.env.CRON_SECRET;
});

describe('GET /api/v1/agentbook/cron/account-hard-delete', () => {
  it('returns 401 when CRON_SECRET is set and the bearer does not match', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const res = await GET(req({ authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(hardDeleteScheduledAccounts).not.toHaveBeenCalled();
  });

  it('runs the job and returns its result when the bearer matches', async () => {
    process.env.CRON_SECRET = 'right-secret';
    hardDeleteScheduledAccounts.mockResolvedValue({ processed: 2, skippedOwnedTeam: [], deleted: [] });
    const res = await GET(req({ authorization: 'Bearer right-secret' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.processed).toBe(2);
  });

  it('returns 500 with success:false when the job throws', async () => {
    process.env.CRON_SECRET = 'right-secret';
    hardDeleteScheduledAccounts.mockRejectedValue(new Error('db down'));
    const res = await GET(req({ authorization: 'Bearer right-secret' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
