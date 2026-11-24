// @vitest-environment node
/**
 * PR 3bc.9 — route-level wiring for every bills route, against the stateful
 * fake ledger: each assertion reads the journal lines the route caused.
 * create at_entry / at_payment, pay, partial pay, void, void payment, amend,
 * delete; soft-deleted bills are 404 on GET/PUT/PATCH.
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
let flagOn = true;
vi.mock('@/lib/purchases-flag', () => ({
  purchasesAtEntryApplies: async (_t: string, cfg: { accountingBasis?: string } | null) => flagOn && !!cfg && cfg.accountingBasis !== 'cash',
}));

import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';
let f: ReturnType<typeof createFakeLedgerDb>;
vi.mock('@naap/database', () => ({
  get prisma() { return f.db; },
}));

import { POST as createBill } from '../route';



const AU = { id: 'cfg', userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD', accountingBasis: 'accrual' };

function req(url: string, body?: unknown) {
  return { url, nextUrl: new URL(url), headers: new Headers(), json: async () => body ?? {} } as never;
}
const B = 'http://x/api/v1/agentbook-expense/bills';

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ ...AU });
});

/**
 * PR 3d.2 — the mobile offline queue replays a "Pay later" capture with the
 * same idempotency key. Both posting modes must create exactly one bill.
 */
describe('POST /bills idempotency (offline replay)', () => {
  for (const mode of ['at_payment', 'at_entry'] as const) {
    it(`${mode}: same key twice → one bill, second call 200 with the same id`, async () => {
      flagOn = mode === 'at_entry';
      const body = { vendorName: 'Hydro One', amountCents: 8450, dueDate: '2026-12-15', billDate: '2026-11-20', idempotencyKey: 'cap-123' };
      const a = await createBill(req(B, body));
      const b = await createBill(req(B, body));
      const [ja, jb] = [await a.json(), await b.json()];
      expect([a.status, b.status, jb.data.id, f.state.bills.length]).toEqual([201, 200, ja.data.id, 1]);
      expect(f.state.bills[0].amountCents).toBe(8450);
    });
  }
  it('at_payment: same key, different amount → 409 idempotency_key_conflict, still one bill', async () => {
    flagOn = false;
    await createBill(req(B, { vendorName: 'Hydro One', amountCents: 8450, dueDate: '2026-12-15', idempotencyKey: 'k' }));
    const r = await createBill(req(B, { vendorName: 'Hydro One', amountCents: 9999, dueDate: '2026-12-15', idempotencyKey: 'k' }));
    expect([r.status, (await r.json()).code, f.state.bills.length]).toEqual([409, 'idempotency_key_conflict', 1]);
  });
});

describe('POST /bills categoryId (Capture sends the account id)', () => {
  it('resolves the tenant’s expense account to its code: at_entry debits that account', async () => {
    flagOn = true;
    const r = await createBill(req(B, { vendorName: 'Hydro One', amountCents: 5000, dueDate: '2026-12-15', categoryId: 'acct-travel' }));
    expect(r.status).toBe(201);
    const debits = f.state.lines.filter((l) => l.debitCents > 0).map((l) => l.accountId);
    expect(debits).toContain('acct-travel');
  });
  it('another tenant’s account id → 422 invalid_category, nothing created', async () => {
    flagOn = true;
    const r = await createBill(req(B, { vendorName: 'Hydro One', amountCents: 5000, dueDate: '2026-12-15', categoryId: 'acct-t2-meals' }));
    expect([r.status, (await r.json()).code, f.state.bills.length]).toEqual([422, 'invalid_category', 0]);
  });
});
