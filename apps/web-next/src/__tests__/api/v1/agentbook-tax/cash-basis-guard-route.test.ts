// @vitest-environment node
/** PR 3bc.8 — ?basis=cash is disabled (falls back to accrual + reason) while OPEN at_entry bills exist. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET as pnlGET } from '@/app/api/v1/agentbook-tax/reports/pnl/route';
import { GET as bsGET } from '@/app/api/v1/agentbook-tax/reports/balance-sheet/route';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const b = (id: string, status: string, postingMode: string, deletedAt: Date | null = null) =>
  ({ id, tenantId: 't1', status, postingMode, deletedAt, amountCents: 1000, paidCents: status === 'partial' ? 400 : 0, createdAt: day('2026-01-05') });

function seed(bills: unknown[], accountingBasis = 'accrual') {
  memDb.reset({
    abTenantConfig: [{ id: 'c', userId: 't1', accountingBasis }],
    abAccount: [], abJournalLine: [], abJournalEntry: [], abEvent: [], abPayment: [], abInvoice: [],
    abBill: bills,
  });
}

type D = { data: { basis?: string; accountingBasis?: string; cashBasisDisabled?: { reason: string; openAtEntryBillCount: number } } };
const pnl = async (qs: string) => (await json<D>(await pnlGET(tenantReq(`/api/v1/agentbook-tax/reports/pnl${qs}`, 't1')))).data;
const bs = async (qs: string) => (await json<D>(await bsGET(tenantReq(`/api/v1/agentbook-tax/reports/balance-sheet${qs}`, 't1')))).data;

describe('cash-basis guard', () => {
  beforeEach(() => seed([b('x1', 'open', 'at_entry'), b('x2', 'partial', 'at_entry'), b('x3', 'paid', 'at_entry'),
    b('x4', 'open', 'at_payment'), b('x5', 'open', 'at_entry', day('2026-01-06')), b('x6', 'cancelled', 'at_entry')]));

  it('P&L ?basis=cash → accrual with reason; counts only live open|partial at_entry bills (2)', async () => {
    const d = await pnl('?basis=cash');
    expect(d.basis).toBe('accrual');
    expect(d.cashBasisDisabled).toEqual({ reason: 'open_at_entry_bills', openAtEntryBillCount: 2 });
  });
  it('balance sheet ?basis=cash → accrual with reason', async () => {
    const d = await bs('?basis=cash&asOfDate=2026-06-30');
    expect(d.accountingBasis).toBe('accrual');
    expect(d.cashBasisDisabled).toEqual({ reason: 'open_at_entry_bills', openAtEntryBillCount: 2 });
  });
  it('tenant configured cash (no param) is guarded too', async () => {
    seed([b('x1', 'open', 'at_entry')], 'cash');
    const d = await pnl('');
    expect(d.basis).toBe('accrual');
    expect(d.cashBasisDisabled?.openAtEntryBillCount).toBe(1);
  });
  it('accrual request: no flag', async () => {
    expect((await pnl('?basis=accrual')).cashBasisDisabled).toBeUndefined();
  });
});

describe('cash basis allowed without open at_entry bills', () => {
  it('only paid at_entry + open at_payment → cash, no flag', async () => {
    seed([b('x3', 'paid', 'at_entry'), b('x4', 'open', 'at_payment')]);
    const d = await pnl('?basis=cash');
    expect(d.basis).toBe('cash');
    expect(d.cashBasisDisabled).toBeUndefined();
    const s = await bs('?basis=cash&asOfDate=2026-06-30');
    expect(s.accountingBasis).toBe('cash');
  });
});
