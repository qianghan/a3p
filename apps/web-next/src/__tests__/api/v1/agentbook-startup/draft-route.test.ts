import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const applicationFindFirst = vi.fn();
const redraftApplicationMock = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ hasAddOn: (...a: unknown[]) => hasAddOnMock(...a) }));
vi.mock('@naap/database', () => ({
  prisma: { startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) } },
}));
vi.mock('@/lib/agentbook-startup/redraft', () => ({ redraftApplication: (...a: unknown[]) => redraftApplicationMock(...a) }));

import { POST } from '@/app/api/v1/agentbook-startup/applications/[id]/draft/route';

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); applicationFindFirst.mockReset(); redraftApplicationMock.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  hasAddOnMock.mockResolvedValue(true);
  applicationFindFirst.mockResolvedValue({ id: 'app-1' });
});

function req(): NextRequest {
  return new NextRequest('http://x', { method: 'POST' });
}

describe('POST /api/v1/agentbook-startup/applications/[id]/draft', () => {
  it('returns 402 without the add-on', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const r = await POST(req(), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(402);
  });

  it('404s when the application does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await POST(req(), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });

  it('delegates to redraftApplication and passes through its status/body', async () => {
    redraftApplicationMock.mockResolvedValue({ status: 200, body: { application: { id: 'app-1', status: 'drafting' } } });
    const r = await POST(req(), { params: Promise.resolve({ id: 'app-1' }) });
    expect(redraftApplicationMock).toHaveBeenCalledWith('app-1');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.application.status).toBe('drafting');
  });
});
