import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const applicationFindFirst = vi.fn();
const runAuditReviewMock = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ hasAddOn: (...a: unknown[]) => hasAddOnMock(...a) }));
vi.mock('@naap/database', () => ({
  prisma: { startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) } },
}));
vi.mock('@/lib/agentbook-startup/audit-review', () => ({ runAuditReview: (...a: unknown[]) => runAuditReviewMock(...a) }));

import { POST } from '@/app/api/v1/agentbook-startup/applications/[id]/audit-review/route';

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); applicationFindFirst.mockReset(); runAuditReviewMock.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  hasAddOnMock.mockResolvedValue(true);
  applicationFindFirst.mockResolvedValue({ id: 'app-1' });
  runAuditReviewMock.mockResolvedValue({ status: 200, body: { application: { id: 'app-1', status: 'audit_reviewed' }, auditReview: { riskLevel: 'low', findings: [] } } });
});

describe('POST /api/v1/agentbook-startup/applications/[id]/audit-review', () => {
  it('returns 402 without the add-on', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const r = await POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(402);
  });

  it('returns 404 when the application does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });

  it('delegates to runAuditReview and forwards its result', async () => {
    const r = await POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.auditReview.riskLevel).toBe('low');
    expect(runAuditReviewMock).toHaveBeenCalledWith('app-1');
  });
});
