import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const decisionPointFindUnique = vi.fn();
const decisionPointUpdate = vi.fn();
const applicationFindFirst = vi.fn();
const redraftApplicationMock = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ hasAddOn: (...a: unknown[]) => hasAddOnMock(...a) }));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitDecisionPoint: {
      findUnique: (...a: unknown[]) => decisionPointFindUnique(...a),
      update: (...a: unknown[]) => decisionPointUpdate(...a),
    },
    startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) },
  },
}));
vi.mock('@/lib/agentbook-startup/redraft', () => ({ redraftApplication: (...a: unknown[]) => redraftApplicationMock(...a) }));

import { POST } from '@/app/api/v1/agentbook-startup/decision-points/[id]/respond/route';

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); decisionPointFindUnique.mockReset();
  decisionPointUpdate.mockReset(); applicationFindFirst.mockReset(); redraftApplicationMock.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  hasAddOnMock.mockResolvedValue(true);
  decisionPointFindUnique.mockResolvedValue({ id: 'dp-1', applicationId: 'app-1' });
  applicationFindFirst.mockResolvedValue({ id: 'app-1' });
  decisionPointUpdate.mockResolvedValue({});
});

function req(body: unknown): NextRequest {
  return new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) });
}

describe('POST /api/v1/agentbook-startup/decision-points/[id]/respond', () => {
  it('returns 402 without the add-on', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const r = await POST(req({ response: 'approve' }), { params: Promise.resolve({ id: 'dp-1' }) });
    expect(r.status).toBe(402);
  });

  it('400s when response is missing', async () => {
    const r = await POST(req({}), { params: Promise.resolve({ id: 'dp-1' }) });
    expect(r.status).toBe(400);
  });

  it('404s when the decision point does not exist', async () => {
    decisionPointFindUnique.mockResolvedValue(null);
    const r = await POST(req({ response: 'approve' }), { params: Promise.resolve({ id: 'dp-1' }) });
    expect(r.status).toBe(404);
  });

  it('404s when the decision point does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await POST(req({ response: 'approve' }), { params: Promise.resolve({ id: 'dp-1' }) });
    expect(r.status).toBe(404);
  });

  it('records the response, then delegates to redraftApplication', async () => {
    redraftApplicationMock.mockResolvedValue({ status: 200, body: { application: { id: 'app-1', status: 'ready_for_review' } } });
    const r = await POST(req({ response: 'approve' }), { params: Promise.resolve({ id: 'dp-1' }) });
    expect(decisionPointUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dp-1' },
      data: expect.objectContaining({ response: 'approve' }),
    }));
    expect(redraftApplicationMock).toHaveBeenCalledWith('app-1');
    expect(r.status).toBe(200);
  });
});
