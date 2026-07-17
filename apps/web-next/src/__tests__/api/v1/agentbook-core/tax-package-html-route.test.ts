import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineFindMany = vi.fn();
const expenseCount = vi.fn();
const taxEstimateFindFirst = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
    abExpense: { count: (...a: unknown[]) => expenseCount(...a) },
    abTaxEstimate: { findFirst: (...a: unknown[]) => taxEstimateFindFirst(...a) },
  },
}));

// Import after all mocks are set up
import { GET } from '@/app/api/v1/agentbook-core/tax-package/html/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-core/tax-package/html?year=2026', { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset();
  tenantConfigFindUnique.mockReset();
  accountFindMany.mockReset();
  journalLineFindMany.mockReset();
  expenseCount.mockReset();
  taxEstimateFindFirst.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockResolvedValue([]);
  journalLineFindMany.mockResolvedValue([]);
  expenseCount.mockResolvedValue(0);
});

describe('GET /api/v1/agentbook-core/tax-package/html — AU-aware labels', () => {
  it('uses AU-specific form name, Medicare Levy label, and ITR category header for an AU tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Business and Professional Items Schedule (myTax individual tax return)');
    expect(html).toContain('Medicare Levy');
    expect(html).toContain('ITR Business Category');
    expect(html).not.toContain('Schedule C');
    expect(html).not.toContain('T2125');
    expect(html).not.toContain('Self-Employment Tax');
  });

  it('still uses the original Canada labels for a CA tenant (unchanged behavior)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', currency: 'CAD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(html).toContain('T2125 — Statement of Business Activities');
    expect(html).toContain('CPP Self-Employed');
    expect(html).toContain('T2125 Category');
  });

  it('still uses the original US labels for a US tenant (unchanged behavior)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD' });
    taxEstimateFindFirst.mockResolvedValue({ seTaxCents: 250000, incomeTaxCents: 1000000, totalTaxCents: 1250000 });

    const res = await GET(req());
    const html = await res.text();

    expect(html).toContain('Schedule C — Profit or Loss from Business');
    expect(html).toContain('Self-Employment Tax');
    expect(html).toContain('Schedule C Category');
  });
});
