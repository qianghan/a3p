import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const applicationFindFirst = vi.fn();
const applicationUpdate = vi.fn();
const auditReviewFindUnique = vi.fn();
const auditReviewUpdate = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ hasAddOn: (...a: unknown[]) => hasAddOnMock(...a) }));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: {
      findFirst: (...a: unknown[]) => applicationFindFirst(...a),
      update: (...a: unknown[]) => applicationUpdate(...a),
    },
    startupBenefitAuditReview: {
      findUnique: (...a: unknown[]) => auditReviewFindUnique(...a),
      update: (...a: unknown[]) => auditReviewUpdate(...a),
    },
  },
}));

import { POST } from '@/app/api/v1/agentbook-startup/applications/[id]/audit-review/override/route';

function req(body: unknown) {
  return new NextRequest('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); applicationFindFirst.mockReset();
  applicationUpdate.mockReset(); auditReviewFindUnique.mockReset(); auditReviewUpdate.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  hasAddOnMock.mockResolvedValue(true);
  applicationFindFirst.mockResolvedValue({ id: 'app-1', status: 'ready_for_review' });
  auditReviewFindUnique.mockResolvedValue({
    applicationId: 'app-1',
    findings: [
      { severity: 'high', issue: 'no cap table', recommendation: 'upload it', ruleRef: 'irs:irc-1202-gross-assets-cap' },
      { severity: 'medium', issue: 'no issuance record', recommendation: 'upload it', ruleRef: 'irs:irc-1202-holding-period' },
    ],
    overrides: [],
  });
  auditReviewUpdate.mockImplementation(({ data }) => ({ applicationId: 'app-1', overrides: data.overrides }));
  applicationUpdate.mockImplementation(({ data }) => ({ id: 'app-1', ...data }));
});

describe('POST /api/v1/agentbook-startup/applications/[id]/audit-review/override', () => {
  it('returns 400 when overriding a high-severity finding without a written reason', async () => {
    const r = await POST(req({ findingIndex: 0 }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(400);
    expect(auditReviewUpdate).not.toHaveBeenCalled();
  });

  it('accepts a high-severity override with a written reason and advances the application to audit_reviewed once no high findings remain unresolved', async () => {
    const r = await POST(req({ findingIndex: 0, reason: 'Cap table confirmed verbally with counsel; upload pending.' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    expect(auditReviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        overrides: [expect.objectContaining({ findingIndex: 0, reason: 'Cap table confirmed verbally with counsel; upload pending.' })],
      }),
    }));
    expect(applicationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'audit_reviewed' } }));
  });

  it('accepts a medium-severity override with no reason required, and does not advance status (medium never blocked it)', async () => {
    const r = await POST(req({ findingIndex: 1 }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    expect(auditReviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ overrides: [expect.objectContaining({ findingIndex: 1, reason: null })] }),
    }));
  });

  it('returns 400 for an out-of-range findingIndex', async () => {
    const r = await POST(req({ findingIndex: 99 }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(400);
  });

  it('returns 404 when no audit review exists yet for this application', async () => {
    auditReviewFindUnique.mockResolvedValue(null);
    const r = await POST(req({ findingIndex: 0, reason: 'x' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });
});
