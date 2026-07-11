import { describe, it, expect, vi, beforeEach } from 'vitest';

const applicationFindUnique = vi.fn();
const applicationUpdate = vi.fn();
const programFindUnique = vi.fn();
const auditReviewUpsert = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: { findUnique: (...a: unknown[]) => applicationFindUnique(...a), update: (...a: unknown[]) => applicationUpdate(...a) },
    startupBenefitProgram: { findUnique: (...a: unknown[]) => programFindUnique(...a) },
    startupBenefitAuditReview: { upsert: (...a: unknown[]) => auditReviewUpsert(...a) },
  },
}));
vi.mock('@agentbook/jurisdictions', () => ({
  getJurisdictionPack: (jurisdiction: string) => {
    if (jurisdiction !== 'us') return undefined;
    return {
      taxBenefits: {
        assessAuditRisk: (_programCode: string, draft: { completeness: number }) =>
          draft.completeness >= 1
            ? { riskLevel: 'low', findings: [] }
            : { riskLevel: 'high', findings: [{ severity: 'high', issue: 'incomplete', recommendation: 'finish it', ruleRef: 'internal:completeness-gate' }] },
      },
    };
  },
  loadBuiltInPacks: () => {},
  AUDIT_REVIEW_MODEL_VERSION: 'us-audit-v1',
}));

import { runAuditReview } from '@/lib/agentbook-startup/audit-review';

beforeEach(() => {
  applicationFindUnique.mockReset(); applicationUpdate.mockReset(); programFindUnique.mockReset(); auditReviewUpsert.mockReset();
  applicationFindUnique.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1', draft: { completeness: 1, programCode: 'us_rd_credit_41', sections: {} } });
  programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us' });
  auditReviewUpsert.mockImplementation(({ create }) => ({ id: 'review-1', applicationId: 'app-1', overrides: [], ...create }));
  applicationUpdate.mockImplementation(({ data }) => ({ id: 'app-1', ...data }));
});

describe('runAuditReview', () => {
  it('advances status to audit_reviewed when the risk assessment has no high-severity findings', async () => {
    const result = await runAuditReview('app-1');
    expect(result.status).toBe(200);
    expect(auditReviewUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { applicationId: 'app-1' },
      create: expect.objectContaining({ riskLevel: 'low', findings: [], modelVersion: 'us-audit-v1', overrides: [] }),
    }));
    expect(applicationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'audit_reviewed', auditRiskLevel: 'low' }),
    }));
  });

  it('does not advance status when the risk assessment has a high-severity finding', async () => {
    applicationFindUnique.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1', draft: { completeness: 0.5, programCode: 'us_rd_credit_41', sections: {} } });
    const result = await runAuditReview('app-1');
    expect(result.status).toBe(200);
    expect(applicationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ready_for_review', auditRiskLevel: 'high' }),
    }));
  });

  it('returns 404 when the application does not exist', async () => {
    applicationFindUnique.mockResolvedValue(null);
    const result = await runAuditReview('nope');
    expect(result.status).toBe(404);
  });

  it('returns 400 when the jurisdiction is not supported', async () => {
    programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'ca_sred', jurisdiction: 'ca' });
    const result = await runAuditReview('app-1');
    expect(result.status).toBe(400);
  });

  it('returns 400 when the draft has no completeness field yet (audit review triggered too early)', async () => {
    applicationFindUnique.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1', draft: {} });
    const result = await runAuditReview('app-1');
    expect(result.status).toBe(400);
  });
});
