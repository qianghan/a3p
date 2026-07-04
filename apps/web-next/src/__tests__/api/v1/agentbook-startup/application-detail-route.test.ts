import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const applicationFindFirst = vi.fn();
const documentFindMany = vi.fn();
const decisionPointFindMany = vi.fn();
const programFindUnique = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@agentbook/jurisdictions', () => ({
  getJurisdictionPack: () => ({
    taxBenefits: {
      getRequiredDocuments: () => [{ docType: 'payroll_register', label: 'Payroll register', description: 'x', required: true }],
    },
  }),
  loadBuiltInPacks: () => {},
}));
vi.mock('@/lib/agentbook-startup/discovery', () => ({}));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) },
    startupBenefitDocument: { findMany: (...a: unknown[]) => documentFindMany(...a) },
    startupBenefitDecisionPoint: { findMany: (...a: unknown[]) => decisionPointFindMany(...a) },
    startupBenefitProgram: { findUnique: (...a: unknown[]) => programFindUnique(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-startup/applications/[id]/route';

beforeEach(() => {
  resolveTenant.mockReset(); applicationFindFirst.mockReset(); documentFindMany.mockReset();
  decisionPointFindMany.mockReset(); programFindUnique.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us' });
});

describe('GET /api/v1/agentbook-startup/applications/[id]', () => {
  it('404s when the application does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });

  it('returns application + documents + decision points + document checklist', async () => {
    applicationFindFirst.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', status: 'drafting', programId: 'prog-1' });
    documentFindMany.mockResolvedValue([{ id: 'doc-1', docType: 'payroll_register' }]);
    decisionPointFindMany.mockResolvedValue([{ id: 'dp-1', sequenceOrder: 1 }]);
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.application.id).toBe('app-1');
    expect(j.documents).toHaveLength(1);
    expect(j.decisionPoints).toHaveLength(1);
    expect(j.documentChecklist).toEqual([{ docType: 'payroll_register', label: 'Payroll register', description: 'x', required: true }]);
  });
});
