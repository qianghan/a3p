import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const programFindFirst = vi.fn();
const applicationCreate = vi.fn();
const applicationFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ hasAddOn: (...a: unknown[]) => hasAddOnMock(...a) }));
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
    startupBenefitProgram: {
      findFirst: (...a: unknown[]) => programFindFirst(...a),
    },
    startupBenefitApplication: {
      create: (...a: unknown[]) => applicationCreate(...a),
      findMany: (...a: unknown[]) => applicationFindMany(...a),
    },
  },
}));

import { POST, GET } from '@/app/api/v1/agentbook-startup/applications/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset();
  programFindFirst.mockReset(); applicationCreate.mockReset(); applicationFindMany.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://x/applications', { method: 'POST', body: JSON.stringify(body) });
}

describe('POST /api/v1/agentbook-startup/applications', () => {
  it('returns 402 without an active add-on subscription', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const r = await POST(postReq({ programCode: 'us_rd_credit_41' }));
    expect(r.status).toBe(402);
  });

  it('creates an application with docs_pending status and returns the document checklist', async () => {
    hasAddOnMock.mockResolvedValue(true);
    programFindFirst.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us' });
    applicationCreate.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1', status: 'docs_pending', draft: {}, createdAt: new Date(), updatedAt: new Date() });

    const r = await POST(postReq({ programCode: 'us_rd_credit_41' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.application.status).toBe('docs_pending');
    expect(j.documentChecklist.length).toBeGreaterThan(0);
    expect(j.documentChecklist[0]).toHaveProperty('docType');
  });

  it('404s for an unknown programCode', async () => {
    hasAddOnMock.mockResolvedValue(true);
    programFindFirst.mockResolvedValue(null);
    const r = await POST(postReq({ programCode: 'nonexistent' }));
    expect(r.status).toBe(404);
  });

  it('400s when programCode is missing', async () => {
    hasAddOnMock.mockResolvedValue(true);
    const r = await POST(postReq({}));
    expect(r.status).toBe(400);
  });
});

describe('GET /api/v1/agentbook-startup/applications', () => {
  it('lists applications without requiring the add-on (view-only)', async () => {
    hasAddOnMock.mockResolvedValue(false);
    applicationFindMany.mockResolvedValue([{ id: 'app-1', status: 'drafting' }]);
    const r = await GET(new NextRequest('http://x/applications'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.applications).toHaveLength(1);
  });
});
