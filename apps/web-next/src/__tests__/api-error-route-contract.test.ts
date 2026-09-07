// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const startOrResume = vi.fn();
const getLatest = vi.fn();
vi.mock('@/lib/billing/sales-rep-application', () => ({
  startOrResumeApplication: (...a: unknown[]) => startOrResume(...a),
  getLatestApplication: (...a: unknown[]) => getLatest(...a),
}));

const resolveTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

import { NextRequest } from 'next/server';
import { PublicError } from '@/lib/api-error';

/**
 * The two halves of the contract, on a real route.
 *
 * The sales-rep application flow reports its rules by throwing them -- "You
 * already have an application in progress." -- and the route surfaces that as
 * a 400. Sanitizing every message would have turned real product copy into
 * "something went wrong", which is a worse product and buys no security. An
 * unexpected error on the same route must still be hidden.
 */

const post = () =>
  new NextRequest('https://app.test/api/v1/agentbook-billing/sales-rep/application', { method: 'POST' });

describe('sales-rep application route — error contract', () => {
  beforeEach(() => {
    startOrResume.mockReset();
    resolveTenant.mockReset().mockResolvedValue({ tenantId: 't1' });
  });

  it('returns the eligibility copy verbatim, because it is written for the user', async () => {
    startOrResume.mockRejectedValue(new PublicError('You already have an application in progress.'));
    const { POST } = await import('@/app/api/v1/agentbook-billing/sales-rep/application/route');
    const res = await POST(post());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('You already have an application in progress.');
  });

  it('hides a Prisma failure on the very same route', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startOrResume.mockRejectedValue(
      new Error('Invalid `prisma.billSalesRep.findFirst()`: relation "BillSalesRep" does not exist'),
    );
    const { POST } = await import('@/app/api/v1/agentbook-billing/sales-rep/application/route');
    const res = await POST(post());
    const body = (await res.json()) as { success: boolean; error: string };

    expect(body.success).toBe(false);
    for (const leak of ['prisma', 'billSalesRep', 'BillSalesRep', 'relation']) {
      expect(body.error, `leaked ${leak}`).not.toContain(leak);
    }
    // Still diagnosable server-side, with a reference the user can quote.
    expect(body.error).toMatch(/Reference: [a-z0-9]+/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
