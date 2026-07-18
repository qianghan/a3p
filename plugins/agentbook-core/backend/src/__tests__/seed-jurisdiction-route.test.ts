import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CA-5 remediation — plugins/agentbook-core/backend/src/server.ts's
 * `POST /api/v1/agentbook-core/accounts/seed-jurisdiction` route used to
 * hardcode a US-only Schedule-C chart of accounts for every tenant
 * regardless of jurisdiction (its own "TODO: also select US_ACCOUNTS
 * variants by jurisdiction when a CA chart lands" comment admitted this).
 * The route now delegates to the same real usChartOfAccounts/
 * caChartOfAccounts/auChartOfAccounts jurisdiction-pack templates the
 * already-correct Next.js equivalent route
 * (apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts)
 * uses, via a CHART_PROVIDERS map, keeping the student-chart carve-out
 * (STUDENT_ACCOUNTS) unchanged and checked first regardless of jurisdiction.
 *
 * The route handler is exported from server.ts as `seedJurisdictionHandler`
 * (extracted from the inline app.post(...) callback, mirroring this same
 * file's own tenantMiddleware precedent in tenant-middleware.test.ts) so it
 * can be unit-tested directly with fabricated req/res objects, without
 * booting the whole Express app or reaching for supertest — no test in this
 * package or any sibling plugin backend (agentbook-expense/-invoice/-tax/
 * -startup) uses supertest; the established convention across all of them
 * is exactly this: mock '../db/client.js' and call an exported function
 * directly. Dynamic `import('../server')` (not a static top-level import)
 * mirrors start-tax-fast-track-skill.test.ts's own documented workaround
 * for ESM import-hoisting: a static `import ... from '../server'` at the
 * top of this file would be hoisted above the `vi.mock('../db/client.js', ...)`
 * factory below, executing before the mock is registered.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const dbMock = {
  abTenantConfig: {
    findUnique: vi.fn(async () => null as any),
  },
  abAccount: {
    upsert: vi.fn(async (args: any) => ({ id: `acc-${args.where.tenantId_code.code}`, ...args.create })),
  },
  $transaction: vi.fn(async (ops: Promise<any>[]) => Promise.all(ops)),
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

function mockReq(tenantId = 'tenant-1') {
  return { tenantId, headers: {} } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTenantConfig.findUnique.mockResolvedValue(null);
  dbMock.abAccount.upsert.mockImplementation(async (args: any) => ({
    id: `acc-${args.where.tenantId_code.code}`,
    ...args.create,
  }));
  dbMock.$transaction.mockImplementation(async (ops: Promise<any>[]) => Promise.all(ops));
});

describe('POST /api/v1/agentbook-core/accounts/seed-jurisdiction (CA-5 remediation)', () => {
  it('a CA tenant gets the real CA chart of accounts (T2125-style codes/names), not the US Schedule-C one', async () => {
    dbMock.abTenantConfig.findUnique.mockResolvedValueOnce({ jurisdiction: 'ca', businessType: 'freelancer' });
    const { seedJurisdictionHandler } = await loadServer();
    const { caChartOfAccounts } = await import('@agentbook/jurisdictions/ca/chart-of-accounts');

    const res = mockRes();
    await seedJurisdictionHandler(mockReq(), res);

    const expected = caChartOfAccounts.getDefaultAccounts('freelancer');
    expect(dbMock.abAccount.upsert).toHaveBeenCalledTimes(expected.length);

    const upsertedCodes = dbMock.abAccount.upsert.mock.calls.map((c: any) => c[0].create.code).sort();
    expect(upsertedCodes).toEqual(expected.map((a) => a.code).sort());

    // The old hardcoded US_ACCOUNTS array used bare US Schedule-C line
    // numbers ('Line 1', 'Line 8', 'Line 20b', ...) and US-specific account
    // names ('Service Revenue', 'Business Checking'). The real CA pack uses
    // CRA T2125 four-digit line numbers ('Line 8000 - Professional income')
    // and CA-specific accounts/names (e.g. 'Capital Cost Allowance', a CCA
    // concept with no US Schedule-C equivalent) — a CA tenant must get
    // those, not the old US-only shape.
    const upserted = dbMock.abAccount.upsert.mock.calls.map((c: any) => c[0].create);
    expect(upserted.some((a: any) => a.name === 'Capital Cost Allowance')).toBe(true);
    expect(upserted.some((a: any) => a.name === 'Service Revenue')).toBe(false);
    expect(upserted.some((a: any) => a.taxCategory === 'Line 1')).toBe(false);
    const taxCategories = upserted.map((a: any) => a.taxCategory).filter(Boolean);
    expect(taxCategories.every((tc: string) => /^Line \d{4} - /.test(tc))).toBe(true);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { count: expected.length } });
  });

  it('an AU tenant gets the real AU chart of accounts', async () => {
    dbMock.abTenantConfig.findUnique.mockResolvedValueOnce({ jurisdiction: 'au', businessType: 'freelancer' });
    const { seedJurisdictionHandler } = await loadServer();
    const { auChartOfAccounts } = await import('@agentbook/jurisdictions/au/chart-of-accounts');

    const res = mockRes();
    await seedJurisdictionHandler(mockReq(), res);

    const expected = auChartOfAccounts.getDefaultAccounts('freelancer');
    expect(dbMock.abAccount.upsert).toHaveBeenCalledTimes(expected.length);

    const upsertedCodes = dbMock.abAccount.upsert.mock.calls.map((c: any) => c[0].create.code).sort();
    expect(upsertedCodes).toEqual(expected.map((a) => a.code).sort());

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { count: expected.length } });
  });

  it('a US tenant is unaffected — still gets the real US chart of accounts', async () => {
    dbMock.abTenantConfig.findUnique.mockResolvedValueOnce({ jurisdiction: 'us', businessType: 'freelancer' });
    const { seedJurisdictionHandler } = await loadServer();
    const { usChartOfAccounts } = await import('@agentbook/jurisdictions/us/chart-of-accounts');

    const res = mockRes();
    await seedJurisdictionHandler(mockReq(), res);

    const expected = usChartOfAccounts.getDefaultAccounts('freelancer');
    expect(dbMock.abAccount.upsert).toHaveBeenCalledTimes(expected.length);

    const upsertedCodes = dbMock.abAccount.upsert.mock.calls.map((c: any) => c[0].create.code).sort();
    expect(upsertedCodes).toEqual(expected.map((a) => a.code).sort());

    // Codes/names/types that existed in both the old hardcoded US_ACCOUNTS
    // array and the real usChartOfAccounts pack must be equivalent — e.g.
    // the base '1000'/Cash/asset row and the Schedule-C 'Line 1' revenue
    // convention on the top-level revenue account.
    const cash = dbMock.abAccount.upsert.mock.calls.find((c: any) => c[0].create.code === '1000')?.[0].create;
    expect(cash).toMatchObject({ name: 'Cash', accountType: 'asset' });

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { count: expected.length } });
  });

  it('a student tenant still gets the student-specific chart, regardless of jurisdiction', async () => {
    dbMock.abTenantConfig.findUnique.mockResolvedValueOnce({ jurisdiction: 'ca', businessType: 'student' });
    const { seedJurisdictionHandler } = await loadServer();

    const res = mockRes();
    await seedJurisdictionHandler(mockReq(), res);

    // STUDENT_ACCOUNTS is a fixed 14-row list (see server.ts) — assert the
    // distinctive student-only codes/categories are present, proving the
    // caChartOfAccounts pack was NOT used for this tenant.
    const upserted = dbMock.abAccount.upsert.mock.calls.map((c: any) => c[0].create);
    expect(upserted).toHaveLength(14);
    expect(upserted.some((a: any) => a.taxCategory === '1098-T / T2202')).toBe(true);
    expect(upserted.some((a: any) => a.name === 'Tuition & Fees')).toBe(true);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { count: 14 } });
  });
});
