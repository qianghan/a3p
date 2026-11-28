// @vitest-environment node
/** Launch follow-up: BAS W1/W2 counted DRAFT pay runs, so wages never paid were reported to the ATO. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const run = (id: string, status: string, grossCents: number, federalTaxCents: number) => ({
  id, tenantId: 't1', status, payDate: day('2026-08-15'), periodEnd: day('2026-08-14'),
  stubs: [{ grossCents, federalTaxCents }],
});

describe('BAS W1/W2', () => {
  it('counts only paid pay runs', async () => {
    memDb.reset({
      abTenantConfig: [{ id: 'c', userId: 't1', jurisdiction: 'au', gstRegistered: true, gstReportingBasis: 'accrual' }],
      abInvoice: [], abExpense: [], abBill: [], abAccount: [], abJournalEntry: [],
      abPayRun: [run('paid', 'paid', 500000, 90000), run('draft', 'draft', 700000, 150000)],
    });
    const res = await json<{ data: { w1TotalWagesCents: number; w2PaygWithheldCents: number } }>(
      await GET(tenantReq('/api/v1/agentbook-tax/au/bas-return?periodStart=2026-07-01&periodEnd=2026-09-30', 't1')));
    expect(res.data.w1TotalWagesCents).toBe(500000);
    expect(res.data.w2PaygWithheldCents).toBe(90000);
  });
});
