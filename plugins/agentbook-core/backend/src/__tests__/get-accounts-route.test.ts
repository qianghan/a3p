import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `GET /api/v1/agentbook-core/accounts?type=expense` used to silently ignore
 * the `type` query param — `plugins/agentbook-expense/frontend/src/pages/
 * Budgets.tsx` has passed it since introduction, but the handler's Prisma
 * `where` never included `accountType`, so it always returned every account
 * type (asset/liability/equity/revenue/expense) regardless of the param.
 *
 * This also blocked a real fix: `ExpenseList.tsx`'s inline "categorize" row
 * picker sourced its dropdown options from `/category-summary` (categories
 * already USED by existing expenses), not from the chart of accounts, so a
 * tenant whose only expense(s) are all uncategorized got a permanently empty,
 * disabled select — there was no categorized expense to "seed" the options
 * list. The fix threads `?type=expense` through this route so ExpenseList can
 * source options from the tenant's real expense accounts instead.
 *
 * The handler is exported (not an inline app.get callback) so it can be
 * unit-tested directly, mirroring this file's own seedJurisdictionHandler
 * precedent (seed-jurisdiction-route.test.ts) — no test in this package or
 * any sibling plugin backend uses supertest.
 */

const dbMock = {
  abAccount: {
    findMany: vi.fn(async () => [] as any[]),
  },
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

async function loadServer() {
  return import('../server');
}

function mockRes() {
  const res: any = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

function mockReq(tenantId = 'tenant-1', query: Record<string, string> = {}) {
  return { tenantId, headers: {}, query } as any;
}

const ALL_ACCOUNTS = [
  { id: 'a1', tenantId: 'tenant-1', code: '1000', name: 'Business Checking', accountType: 'asset', isActive: true },
  { id: 'a2', tenantId: 'tenant-1', code: '4000', name: 'Service Revenue', accountType: 'revenue', isActive: true },
  { id: 'a3', tenantId: 'tenant-1', code: '5010', name: 'Office Supplies', accountType: 'expense', isActive: true },
  { id: 'a4', tenantId: 'tenant-1', code: '5020', name: 'Software', accountType: 'expense', isActive: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abAccount.findMany.mockImplementation(async (args: any) => {
    // Real Prisma behaviour: filter the fixture by whatever `where` was passed.
    return ALL_ACCOUNTS.filter((a) => {
      if (a.tenantId !== args.where.tenantId) return false;
      if (args.where.isActive !== undefined && a.isActive !== args.where.isActive) return false;
      if (args.where.accountType !== undefined && a.accountType !== args.where.accountType) return false;
      return true;
    });
  });
});

describe('GET /api/v1/agentbook-core/accounts', () => {
  it('with no type param, returns every active account type (existing behaviour preserved)', async () => {
    const { getAccountsHandler } = await loadServer();
    const res = mockRes();
    await getAccountsHandler(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: ALL_ACCOUNTS });
  });

  it('with type=expense, returns ONLY expense-type accounts — not asset/revenue/etc', async () => {
    const { getAccountsHandler } = await loadServer();
    const res = mockRes();
    await getAccountsHandler(mockReq('tenant-1', { type: 'expense' }), res);

    const call = res.json.mock.calls[0][0];
    expect(call.success).toBe(true);
    expect(call.data.map((a: any) => a.accountType)).toEqual(['expense', 'expense']);
    expect(call.data.map((a: any) => a.name).sort()).toEqual(['Office Supplies', 'Software']);
  });

  it('a tenant with zero expenses still gets the full expense chart of accounts — the bug this fixes', async () => {
    // The old /category-summary-derived picker returned [] here because it
    // only ever reflected categories already present on existing expenses.
    const { getAccountsHandler } = await loadServer();
    const res = mockRes();
    await getAccountsHandler(mockReq('tenant-1', { type: 'expense' }), res);

    const call = res.json.mock.calls[0][0];
    expect(call.data.length).toBeGreaterThan(0);
  });
});
