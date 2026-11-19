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

/*
 * M4 — a ledger where cash and accrual DIFFER, so "served accrual" is a computed claim:
 *   invoice entry 2026-02-01: DR AR 10000 / CR revenue 10000   → accrual revenue 10000
 *   customer payment 2026-02-10: abPayment 3000                 → cash revenue 3000
 *   at_entry bill 2026-03-01: DR expense 500 / CR A/P 500       → accrual expenses 500, cash 0 (no 1000 line)
 */
function seedLedger(bills: unknown[]) {
  const e = (id: string, date: string) => ({ id, tenantId: 't1', date: day(date), lines: [] as unknown[] });
  const inv = e('je-inv', '2026-02-01');
  const bil = e('je-bill', '2026-03-01');
  const ln = (id: string, accountId: string, en: ReturnType<typeof e>, debitCents: number, creditCents: number) => {
    const l = { id, accountId, entryId: en.id, entry: en, debitCents, creditCents };
    en.lines.push({ id, accountId, debitCents, creditCents });
    return l;
  };
  memDb.reset({
    abTenantConfig: [{ id: 'c', userId: 't1', accountingBasis: 'accrual' }],
    abAccount: [
      { id: 'cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
      { id: 'ar', tenantId: 't1', code: '1100', name: 'AR', accountType: 'asset', isActive: true },
      { id: 'ap', tenantId: 't1', code: '2000', name: 'A/P', accountType: 'liability', isActive: true },
      { id: 'rev', tenantId: 't1', code: '4000', name: 'Revenue', accountType: 'revenue', isActive: true },
      { id: 'exp', tenantId: 't1', code: '5000', name: 'Expense', accountType: 'expense', isActive: true },
    ],
    abJournalLine: [ln('l1', 'ar', inv, 10000, 0), ln('l2', 'rev', inv, 0, 10000), ln('l3', 'exp', bil, 500, 0), ln('l4', 'ap', bil, 0, 500)],
    abJournalEntry: [inv, bil], abEvent: [], abInvoice: [],
    abPayment: [{ id: 'p1', tenantId: 't1', date: day('2026-02-10'), amountCents: 3000 }],
    abBill: bills,
  });
}
type P = { data: { basis: string; grossRevenueCents: number; totalExpensesCents: number; netIncomeCents: number; cashBasisDisabled?: unknown } };
const pnlFull = async (qs: string) => (await json<P>(await pnlGET(tenantReq(`/api/v1/agentbook-tax/reports/pnl${qs}`, 't1')))).data;
const Q = '?basis=cash&startDate=2026-01-01&endDate=2026-06-30';

describe('M4: guarded P&L serves the ACCRUAL numbers', () => {
  it('open at_entry bill → revenue 10000, expenses 500, net 9500 (accrual)', async () => {
    seedLedger([b('x1', 'open', 'at_entry')]);
    const d = await pnlFull(Q);
    expect([d.basis, d.grossRevenueCents, d.totalExpensesCents, d.netIncomeCents]).toEqual(['accrual', 10000, 500, 9500]);
  });
  it('same ledger, bill paid → cash numbers: revenue 3000, expenses 0', async () => {
    seedLedger([b('x1', 'paid', 'at_entry')]);
    const d = await pnlFull(Q);
    expect([d.basis, d.grossRevenueCents, d.totalExpensesCents, d.netIncomeCents]).toEqual(['cash', 3000, 0, 3000]);
  });
});

describe('I1: tenant-config exposes the block for Settings', () => {
  it('returns cashBasisDisabled top-level (not inside the PUT-able config)', async () => {
    seed([b('x1', 'open', 'at_entry'), b('x2', 'open', 'at_entry')]);
    const { GET } = await import('@/app/api/v1/agentbook-core/tenant-config/route');
    const body = await json<{ data: Record<string, unknown>; cashBasisDisabled: unknown }>(await GET(tenantReq('/api/v1/agentbook-core/tenant-config', 't1')));
    expect(body.cashBasisDisabled).toEqual({ reason: 'open_at_entry_bills', openAtEntryBillCount: 2 });
    expect(body.data.cashBasisDisabled).toBeUndefined();
  });
});
