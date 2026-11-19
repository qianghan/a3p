// @vitest-environment node
/** PR 3bc.5 — balance-sheet ROUTE over mixed bills (wiring into lib/balance-sheet + bill-amounts). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET } from '@/app/api/v1/agentbook-tax/reports/balance-sheet/route';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const entry = (id: string, date: string) => ({ id, tenantId: 't1', date: day(date) });
const ln = (id: string, accountId: string, e: ReturnType<typeof entry>, debitCents: number, creditCents: number) =>
  ({ id, accountId, entryId: e.id, entry: e, debitCents, creditCents });

beforeEach(() => {
  const cap = entry('je-cap', '2026-01-02');
  const bill = entry('je-bill', '2026-03-01'); // at_entry bill b2 on its billDate
  memDb.reset({
    abTenantConfig: [{ id: 'c', userId: 't1', accountingBasis: 'accrual' }],
    abAccount: [
      { id: 'cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
      { id: 'ap', tenantId: 't1', code: '2000', name: 'Accounts Payable', accountType: 'liability', isActive: true },
      { id: 'eq', tenantId: 't1', code: '3000', name: 'Owner', accountType: 'equity', isActive: true },
      { id: 'exp', tenantId: 't1', code: '5000', name: 'Expense', accountType: 'expense', isActive: true },
    ],
    abJournalLine: [
      ln('l1', 'cash', cap, 50000, 0), ln('l2', 'eq', cap, 0, 50000),
      ln('l3', 'exp', bill, 500, 0), ln('l4', 'ap', bill, 0, 500),
    ],
    abBill: [
      { id: 'b1', tenantId: 't1', amountCents: 1000, paidCents: 0, status: 'open', postingMode: 'at_payment', deletedAt: null, createdAt: day('2026-02-01') },
      { id: 'b2', tenantId: 't1', amountCents: 500, paidCents: 0, status: 'open', postingMode: 'at_entry', deletedAt: null, createdAt: day('2026-03-01') },
      { id: 'b3', tenantId: 't1', amountCents: 9999, paidCents: 0, status: 'paid', postingMode: 'at_payment', deletedAt: null, createdAt: day('2026-02-01') },
      { id: 'b4', tenantId: 't1', amountCents: 7777, paidCents: 0, status: 'open', postingMode: 'at_payment', deletedAt: day('2026-02-03'), createdAt: day('2026-02-01') },
    ],
    abEvent: [],
  });
});

describe('GET /reports/balance-sheet with mixed bills', () => {
  it('one A/P line = at_payment derived 1000 + journal 2000 500; RE offset only the derived part; balanced', async () => {
    const body = await json<{ data: { liabilities: Array<{ code: string; balanceCents: number }>; accountsPayableOpenCents: number; retainedEarningsCents: number; totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; balanced: boolean } }>(
      await GET(tenantReq('/api/v1/agentbook-tax/reports/balance-sheet?asOfDate=2026-06-30', 't1')),
    );
    const d = body.data;
    expect(d.accountsPayableOpenCents).toBe(1000);
    expect(d.liabilities.filter((l) => l.code === '2000')).toEqual([expect.objectContaining({ balanceCents: 1500 })]);
    expect(d.retainedEarningsCents).toBe(-500 - 1000);
    expect(d.totalAssetsCents).toBe(50000);
    expect(d.totalLiabilitiesCents + d.totalEquityCents).toBe(50000);
    expect(d.balanced).toBe(true);
  });

  it('before the at_entry billDate the journal A/P is absent; legacy derived dated by createdAt', async () => {
    const d = (await json<{ data: { liabilities: Array<{ code: string; balanceCents: number }>; balanced: boolean } }>(
      await GET(tenantReq('/api/v1/agentbook-tax/reports/balance-sheet?asOfDate=2026-02-15', 't1')),
    )).data;
    expect(d.liabilities.filter((l) => l.code === '2000').map((l) => l.balanceCents)).toEqual([1000]);
    expect(d.balanced).toBe(true);
  });
});
