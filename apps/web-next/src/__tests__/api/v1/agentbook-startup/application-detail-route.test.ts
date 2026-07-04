import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const applicationFindFirst = vi.fn();
const documentFindMany = vi.fn();
const decisionPointFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) },
    startupBenefitDocument: { findMany: (...a: unknown[]) => documentFindMany(...a) },
    startupBenefitDecisionPoint: { findMany: (...a: unknown[]) => decisionPointFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-startup/applications/[id]/route';

beforeEach(() => {
  resolveTenant.mockReset(); applicationFindFirst.mockReset(); documentFindMany.mockReset(); decisionPointFindMany.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('GET /api/v1/agentbook-startup/applications/[id]', () => {
  it('404s when the application does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });

  it('returns application + documents + decision points', async () => {
    applicationFindFirst.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', status: 'drafting' });
    documentFindMany.mockResolvedValue([{ id: 'doc-1', docType: 'payroll_register' }]);
    decisionPointFindMany.mockResolvedValue([{ id: 'dp-1', sequenceOrder: 1 }]);
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.application.id).toBe('app-1');
    expect(j.documents).toHaveLength(1);
    expect(j.decisionPoints).toHaveLength(1);
  });
});
