import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const profileFindUnique = vi.fn();
const tenantConfigFindUnique = vi.fn();
const programFindMany = vi.fn();
const assessmentCreate = vi.fn();
const computeRecommendationsMock = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitProfile: { findUnique: (...a: unknown[]) => profileFindUnique(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    startupBenefitProgram: { findMany: (...a: unknown[]) => programFindMany(...a) },
    startupBenefitEligibilityAssessment: { create: (...a: unknown[]) => assessmentCreate(...a) },
  },
}));
vi.mock('@/lib/agentbook-startup/discovery', () => ({
  computeRecommendations: (...a: unknown[]) => computeRecommendationsMock(...a),
}));

import { GET } from '@/app/api/v1/agentbook-startup/recommendations/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset();
  profileFindUnique.mockReset();
  tenantConfigFindUnique.mockReset();
  programFindMany.mockReset();
  assessmentCreate.mockReset();
  computeRecommendationsMock.mockReset();
  resolveTenant.mockResolvedValue(tenant);
  assessmentCreate.mockResolvedValue({});
});

function req(): NextRequest {
  return new NextRequest('http://x/recommendations');
}

describe('GET /api/v1/agentbook-startup/recommendations', () => {
  it('requires a saved profile first', async () => {
    profileFindUnique.mockResolvedValue(null);
    const r = await GET(req());
    expect(r.status).toBe(400);
  });

  it('dispatches through computeRecommendations with the tenant jurisdiction and catalog, and logs an audit row per program', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 'tenant-1', companyType: 'c_corp', incorporatedAt: null, headcount: 4, annualRdSpendCents: 40_000_000, equityRaisedCents: null });
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    programFindMany.mockResolvedValue([{ id: 'prog-1', programCode: 'us_rd_credit_41', name: 'R&D Credit', authority: 'IRS', sourceUrl: 'https://x' }]);
    computeRecommendationsMock.mockReturnValue({
      jurisdiction: 'us',
      programs: [{ programCode: 'us_rd_credit_41', name: 'R&D Credit', authority: 'IRS', sourceUrl: 'https://x', status: 'qualified', confidence: 0.75, reasoning: 'r', estValueLowCents: 4_000_000, estValueHighCents: 8_000_000 }],
    });
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(computeRecommendationsMock).toHaveBeenCalledWith('us', expect.objectContaining({ companyType: 'c_corp', annualRdSpendCents: 40_000_000 }), expect.arrayContaining([expect.objectContaining({ programCode: 'us_rd_credit_41' })]));
    const j = await r.json();
    expect(j.programs[0].programCode).toBe('us_rd_credit_41');
    expect(assessmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 'tenant-1', programId: 'prog-1', status: 'qualified' }),
    }));
  });

  it('defaults jurisdiction to us when no tenant config exists', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 'tenant-1', companyType: null, incorporatedAt: null, headcount: null, annualRdSpendCents: null, equityRaisedCents: null });
    tenantConfigFindUnique.mockResolvedValue(null);
    programFindMany.mockResolvedValue([]);
    computeRecommendationsMock.mockReturnValue({ jurisdiction: 'us', programs: [], message: 'none yet' });
    await GET(req());
    expect(computeRecommendationsMock).toHaveBeenCalledWith('us', expect.anything(), expect.anything());
  });
});
