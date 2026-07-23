import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const invoiceFindMany = vi.fn();
const expenseFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abInvoice: { findMany: (...a: unknown[]) => invoiceFindMany(...a) },
    abExpense: { findMany: (...a: unknown[]) => expenseFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';

function req(qs = '?periodStart=2026-01-01&periodEnd=2026-03-31'): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook-tax/au/bas-return${qs}`, { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset(); tenantConfigFindUnique.mockReset(); invoiceFindMany.mockReset(); expenseFindMany.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 't1' });
});

describe('GET /agentbook-tax/au/bas-return', () => {
  it('computes BAS GST labels from AU invoices (1A) and expenses (1B)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    invoiceFindMany.mockResolvedValue([{ amountCents: 1_100_000, taxCents: 100_000 }]); // $10k + 10% GST
    expenseFindMany.mockResolvedValue([{ taxAmountCents: 20_000 }]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.g1TotalSalesCents).toBe(1_100_000); // gross (GST-inclusive)
    expect(body.data.label1AGstOnSalesCents).toBe(100_000);
    expect(body.data.label1BGstOnPurchasesCents).toBe(20_000);
    expect(body.data.netGstCents).toBe(80_000);
    expect(body.data.outcome).toBe('payable');
  });

  it('422s for a non-AU tenant and never queries invoices', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    const res = await GET(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unsupported_jurisdiction');
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });
});
