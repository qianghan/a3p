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

import { GET } from '@/app/api/v1/agentbook-tax/ca/gst-hst-return/route';

function req(qs = '?periodStart=2026-01-01&periodEnd=2026-03-31'): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook-tax/ca/gst-hst-return${qs}`, { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset(); tenantConfigFindUnique.mockReset(); invoiceFindMany.mockReset(); expenseFindMany.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 't1' });
});

describe('GET /agentbook-tax/ca/gst-hst-return', () => {
  it('computes the return from CA invoices (collected) and expenses (ITCs)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    invoiceFindMany.mockResolvedValue([{ amountCents: 1_130_000, taxCents: 130_000 }]); // $10k + 13% HST
    expenseFindMany.mockResolvedValue([{ taxAmountCents: 26_000 }]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.line105GstHstCollectedCents).toBe(130_000);
    expect(body.data.line108ItcCents).toBe(26_000);
    expect(body.data.line109NetTaxCents).toBe(104_000);
    expect(body.data.line101TotalSalesCents).toBe(1_000_000); // net of tax
    expect(body.data.outcome).toBe('balance_owing');
  });

  it('422s for a non-CA tenant and never queries invoices', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    const res = await GET(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unsupported_jurisdiction');
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });
});
