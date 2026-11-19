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

// PR 2b.7 golden mixed fixture (QC tenant): typed + untyped rows.
const QC_MIXED_EXPENSES = [
  // GST_QST: net 100000 → GST 5000 + QST 9975 = 14975 recoverable; gross 114975
  { amountCents: 114_975, taxAmountCents: 14_975, taxCode: 'GST_QST', recoverableTaxCents: 14_975 },
  // GST only: net 10000 → GST 500; gross 10500
  { amountCents: 10_500, taxAmountCents: 500, taxCode: 'GST', recoverableTaxCents: 500 },
  // EXEMPT with OCR tax 300 kept → no ITC
  { amountCents: 3_300, taxAmountCents: 300, taxCode: 'EXEMPT', recoverableTaxCents: 0 },
  // untyped legacy: whole taxAmountCents is the ITC (today's behaviour)
  { amountCents: 11_300, taxAmountCents: 1_300, taxCode: null, recoverableTaxCents: 0 },
];

describe('GET /agentbook-tax/ca/gst-hst-return — typed expenses (PR 2b.7 golden)', () => {
  it('GST+QST registrant: line 108 is GST/HST only; QST ITR separated', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true });
    invoiceFindMany.mockResolvedValue([]);
    expenseFindMany.mockResolvedValue(QC_MIXED_EXPENSES);
    const body = await (await GET(req())).json();
    // line 108 = 5000 (GST part of GST_QST) + 500 (GST) + 0 (EXEMPT, not its 300) + 1300 (untyped) = 6800
    expect(body.data.line108ItcCents).toBe(6_800);
    // QST ITR = 9975 (QST part of GST_QST)
    expect(body.data.qstItrCents).toBe(9_975);
  });

  it('not QST-registered: QST ITR is 0 (stored recoverable is GST-only)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: false });
    invoiceFindMany.mockResolvedValue([]);
    expenseFindMany.mockResolvedValue([
      // engine stores only the GST credit (5000) when qstRegistered !== true
      { amountCents: 114_975, taxAmountCents: 14_975, taxCode: 'GST_QST', recoverableTaxCents: 5_000 },
    ]);
    const body = await (await GET(req())).json();
    expect(body.data.line108ItcCents).toBe(5_000);
    expect(body.data.qstItrCents).toBe(0);
  });

  it('non-registrant (gstRegistered === false): no ITCs at all', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: false, qstRegistered: false });
    invoiceFindMany.mockResolvedValue([]);
    expenseFindMany.mockResolvedValue(QC_MIXED_EXPENSES);
    const body = await (await GET(req())).json();
    expect(body.data.line108ItcCents).toBe(0);
    expect(body.data.qstItrCents).toBe(0);
  });
});

describe('GST_QST split derives from the stored recoverable, not today\'s flags (2b.7 I-1)', () => {
  it('row booked GST-only, tenant NOW qstRegistered → all 5000 on line 108, 0 QST', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true });
    invoiceFindMany.mockResolvedValue([]);
    expenseFindMany.mockResolvedValue([
      { amountCents: 114_975, taxAmountCents: 14_975, taxCode: 'GST_QST', recoverableTaxCents: 5_000 },
    ]);
    const body = await (await GET(req())).json();
    expect(body.data.line108ItcCents).toBe(5_000);
    expect(body.data.qstItrCents).toBe(0);
  });

  it('row booked with QST, tenant NOW not qstRegistered → still 5000 / 9975 (booking state wins)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: false });
    invoiceFindMany.mockResolvedValue([]);
    expenseFindMany.mockResolvedValue([
      { amountCents: 114_975, taxAmountCents: 14_975, taxCode: 'GST_QST', recoverableTaxCents: 14_975 },
    ]);
    const body = await (await GET(req())).json();
    expect(body.data.line108ItcCents).toBe(5_000);
    expect(body.data.qstItrCents).toBe(9_975);
  });

  it('sum invariant: line108 + QST ITR === stored recoverable for each GST_QST row', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true });
    invoiceFindMany.mockResolvedValue([]);
    for (const [gross, rec] of [[114_975, 14_975], [11_497, 1_497], [999, 129], [114_975, 5_000], [2_300, 0]]) {
      expenseFindMany.mockResolvedValue([{ amountCents: gross, taxAmountCents: rec, taxCode: 'GST_QST', recoverableTaxCents: rec }]);
      const body = await (await GET(req())).json();
      expect(body.data.line108ItcCents + body.data.qstItrCents).toBe(rec);
    }
  });
});
