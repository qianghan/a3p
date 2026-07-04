import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const applicationFindFirst = vi.fn();
const documentFindMany = vi.fn();
const decisionPointFindMany = vi.fn();
const programFindUnique = vi.fn();
const auditReviewFindUnique = vi.fn();

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
    startupBenefitAuditReview: { findUnique: (...a: unknown[]) => auditReviewFindUnique(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-startup/applications/[id]/route';

beforeEach(() => {
  resolveTenant.mockReset(); applicationFindFirst.mockReset(); documentFindMany.mockReset();
  decisionPointFindMany.mockReset(); programFindUnique.mockReset(); auditReviewFindUnique.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us', name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765' });
  auditReviewFindUnique.mockResolvedValue(null);
  documentFindMany.mockResolvedValue([]);
  decisionPointFindMany.mockResolvedValue([]);
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

  it('includes the audit review and program info in the response when an audit review exists', async () => {
    applicationFindFirst.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', status: 'ready_for_review', programId: 'prog-1' });
    programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_qsbs_tracking', jurisdiction: 'us', name: 'QSBS Eligibility Tracking (IRC §1202)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf' });
    auditReviewFindUnique.mockResolvedValue({ applicationId: 'app-1', riskLevel: 'medium', findings: [], overrides: [], modelVersion: 'us-audit-v1' });
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    const j = await r.json();
    expect(j.auditReview).toMatchObject({ riskLevel: 'medium' });
    expect(j.program).toEqual({ name: 'QSBS Eligibility Tracking (IRC §1202)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf' });
  });

  it('returns auditReview: null and program: null when neither exists', async () => {
    applicationFindFirst.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', status: 'drafting', programId: 'prog-1' });
    programFindUnique.mockResolvedValue(null);
    auditReviewFindUnique.mockResolvedValue(null);
    const r = await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: 'app-1' }) });
    const j = await r.json();
    expect(j.auditReview).toBeNull();
    expect(j.program).toBeNull();
  });
});
