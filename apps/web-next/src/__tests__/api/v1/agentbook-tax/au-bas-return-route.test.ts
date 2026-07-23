import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const invoiceFindMany = vi.fn();
const expenseFindMany = vi.fn();
const payRunFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abInvoice: { findMany: (...a: unknown[]) => invoiceFindMany(...a) },
    abExpense: { findMany: (...a: unknown[]) => expenseFindMany(...a) },
    abPayRun: { findMany: (...a: unknown[]) => payRunFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';

function req(qs = '?periodStart=2026-01-01&periodEnd=2026-03-31'): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook-tax/au/bas-return${qs}`, { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset(); tenantConfigFindUnique.mockReset(); invoiceFindMany.mockReset(); expenseFindMany.mockReset(); payRunFindMany.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 't1' });
  payRunFindMany.mockResolvedValue([]); // default: no employees
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

  it('includes PAYG-W (W1/W2) from pay runs in the period', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    invoiceFindMany.mockResolvedValue([{ amountCents: 110_000, taxCents: 10_000 }]);
    expenseFindMany.mockResolvedValue([{ taxAmountCents: 4_000 }]);
    payRunFindMany.mockResolvedValue([
      { stubs: [{ grossCents: 500_000, federalTaxCents: 90_000 }, { grossCents: 300_000, federalTaxCents: 50_000 }] },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.w1TotalWagesCents).toBe(800_000);
    expect(body.data.w2PaygWithheldCents).toBe(140_000);
    expect(body.data.netGstCents).toBe(6_000);
    expect(body.data.totalPayableCents).toBe(146_000); // net GST + PAYG-W
  });

  it('422s for a non-AU tenant and never queries invoices', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    const res = await GET(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unsupported_jurisdiction');
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });
});
