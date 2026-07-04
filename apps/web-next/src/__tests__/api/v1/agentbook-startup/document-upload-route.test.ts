import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const checkQuotaMock = vi.fn();
const incrementUsageMock = vi.fn();
const applicationFindFirst = vi.fn();
const programFindUnique = vi.fn();
const documentCreate = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({
  hasAddOn: (...a: unknown[]) => hasAddOnMock(...a),
  checkQuota: (...a: unknown[]) => checkQuotaMock(...a),
  incrementUsage: (...a: unknown[]) => incrementUsageMock(...a),
}));
vi.mock('@agentbook/jurisdictions', () => ({
  getJurisdictionPack: () => ({
    taxBenefits: {
      getRequiredDocuments: () => [{ docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid.', required: true }],
    },
  }),
  loadBuiltInPacks: () => {},
}));
vi.mock('@/lib/agentbook-startup/discovery', () => ({}));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitApplication: { findFirst: (...a: unknown[]) => applicationFindFirst(...a) },
    startupBenefitProgram: { findUnique: (...a: unknown[]) => programFindUnique(...a) },
    startupBenefitDocument: { create: (...a: unknown[]) => documentCreate(...a) },
  },
}));
vi.mock('@vercel/blob', () => ({ put: vi.fn().mockResolvedValue({ url: 'https://blob.example/doc.pdf' }) }));

global.fetch = vi.fn();

import { POST } from '@/app/api/v1/agentbook-startup/applications/[id]/documents/route';

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); checkQuotaMock.mockReset(); incrementUsageMock.mockReset();
  applicationFindFirst.mockReset(); programFindUnique.mockReset(); documentCreate.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  hasAddOnMock.mockResolvedValue(true);
  checkQuotaMock.mockResolvedValue({ allowed: true, used: 0, limit: 10, remaining: 10 });
  incrementUsageMock.mockResolvedValue(undefined);
  applicationFindFirst.mockResolvedValue({ id: 'app-1', tenantId: 'tenant-1', programId: 'prog-1' });
  programFindUnique.mockResolvedValue({ id: 'prog-1', programCode: 'us_rd_credit_41', jurisdiction: 'us' });
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '{"totalWagesCents": 2500000, "confidence": 0.9}' }] } }] }),
  });
  delete (process.env as Record<string, string | undefined>).GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
});

function multipartReq(docType: string): NextRequest {
  const form = new FormData();
  form.append('docType', docType);
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'payroll.pdf', { type: 'application/pdf' }));
  return new NextRequest('http://x', { method: 'POST', body: form });
}

describe('POST /api/v1/agentbook-startup/applications/[id]/documents', () => {
  it('returns 402 without the add-on', async () => {
    hasAddOnMock.mockResolvedValue(false);
    const r = await POST(multipartReq('payroll_register'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(402);
  });

  it('returns 429 when the ocr_scans quota is exhausted', async () => {
    checkQuotaMock.mockResolvedValue({ allowed: false, used: 10, limit: 10, remaining: 0, reason: 'quota_exceeded' });
    const r = await POST(multipartReq('payroll_register'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(429);
  });

  it('404s when the application does not belong to this tenant', async () => {
    applicationFindFirst.mockResolvedValue(null);
    const r = await POST(multipartReq('payroll_register'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(404);
  });

  it('stores the document, extracts structured data, and increments ocr_scans usage', async () => {
    documentCreate.mockResolvedValue({ id: 'doc-1', applicationId: 'app-1', docType: 'payroll_register', blobUrl: 'https://blob.example/doc.pdf', extractedData: { totalWagesCents: 2500000, confidence: 0.9 }, status: 'uploaded' });
    const r = await POST(multipartReq('payroll_register'), { params: Promise.resolve({ id: 'app-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.document.extractedData).toEqual({ totalWagesCents: 2500000, confidence: 0.9 });
    expect(incrementUsageMock).toHaveBeenCalledWith('tenant-1', 'ocr_scans', 1);
  });
});
