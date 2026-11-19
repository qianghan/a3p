// @vitest-environment node
/**
 * PR 3bc.10 / R-AP-3 — POST /bills with the REAL lib/purchases-flag (not mocked) reading a FeatureFlag row:
 * no row, a row without metadata, and an allowlist that names another tenant all create the legacy at_payment
 * bill, which pays exactly as before (DR category / CR 1000, keyed bill/payment.id, no 2000 line). Only an
 * allowlisted accrual tenant posts at entry; a cash-basis tenant never does.
 * Prod evidence for the same path: tests/e2e/mobile-app/bills.spec.ts (jordan legacy control, every run).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: async () => ({ seeded: false, count: 0 }),
  ensureUncategorizedAccount: async () => ({ id: 'acct-suspense' }),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: async () => null }));

import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';
let f: ReturnType<typeof createFakeLedgerDb>;
let flagRow: Record<string, unknown> | null = null;
vi.mock('@naap/database', () => ({
  get prisma() {
    return { ...f.db, featureFlag: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === 'purchases_at_entry' ? flagRow : null) } };
  },
}));

import { POST as createBill } from '../route';
import { POST as payRoute } from '../[id]/route';

const B = 'http://x/api/v1/agentbook-expense/bills';
const req = (url: string, body?: unknown) => ({ url, nextUrl: new URL(url), headers: new Headers(), json: async () => body ?? {} }) as never;
const body = { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-02', billDate: '2026-11-02', categoryCode: '5200' };

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ id: 'cfg', userId: 't1', jurisdiction: 'us', currency: 'USD', accountingBasis: 'accrual' });
  flagRow = null;
});

async function create() {
  const res = await createBill(req(B, body));
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

describe('unflagged tenants keep the legacy path', () => {
  for (const [label, row] of [
    ['no flag row', null],
    ['row off, metadata absent', { enabled: false, metadata: null }],
    ['row off, allowlist names another tenant', { enabled: false, metadata: { tenantIds: ['t2'] } }],
  ] as const) {
    it(`${label}: at_payment, no entry until paid; pay = DR 5200 / CR 1000 keyed by the payment, no AP line`, async () => {
      flagRow = row as Record<string, unknown> | null;
      const bill = await create();
      expect([bill.postingMode, f.state.entries.length]).toEqual(['at_payment', 0]);
      const paid = await (await payRoute(req(`${B}/${bill.id}?action=pay`, { paidDate: '2026-11-10' }), { params: Promise.resolve({ id: bill.id }) })).json();
      expect(paid.data.status).toBe('paid');
      expect(f.state.entries.map((e) => [e.sourceType, e.sourceId])).toEqual([['bill', paid.payment.id]]);
      expect(f.netByAccount()).toEqual({ 'acct-meals': 5000, 'acct-cash': -5000 });
    });
  }
});

describe('flagged tenants', () => {
  it('allowlisted accrual tenant posts at entry (CR 2000)', async () => {
    flagRow = { enabled: false, metadata: { tenantIds: ['t1'] } };
    const bill = await create();
    expect(bill.postingMode).toBe('at_entry');
    expect(f.netByAccount()['acct-ap']).toBe(-5000);
  });
  it('allowlisted but cash-basis: still at_payment', async () => {
    flagRow = { enabled: true, metadata: null };
    f.state.tenantConfigs[0].accountingBasis = 'cash';
    const bill = await create();
    expect([bill.postingMode, f.state.entries.length]).toEqual(['at_payment', 0]);
  });
});
