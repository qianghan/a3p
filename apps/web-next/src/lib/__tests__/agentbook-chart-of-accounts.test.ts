/**
 * Chart-of-accounts seed-on-demand.
 *
 * The chart was created ONLY by the onboarding flow, so a tenant who skipped
 * onboarding had no Cash (1000) account and every posting path silently skipped
 * the ledger. `ensureChartOfAccounts` closes that by seeding on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const accountFindUnique = vi.fn();
const accountFindMany = vi.fn();
const accountUpsert = vi.fn();
const accountCreate = vi.fn();
const tenantFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abAccount: {
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      findMany: (...a: unknown[]) => accountFindMany(...a),
      upsert: (...a: unknown[]) => accountUpsert(...a),
      create: (...a: unknown[]) => accountCreate(...a),
    },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { ensureChartOfAccounts, CASH_CODE } from '../agentbook-chart-of-accounts';

/** The real pack's codes, so "already complete" cannot drift from the source. */
async function packCodes(jurisdiction: string): Promise<string[]> {
  const { caPack } = await import('@agentbook/jurisdictions');
  void jurisdiction;
  return caPack.chartOfAccounts.getDefaultAccounts('freelancer').map((a: { code: string }) => a.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction receives an array of upsert promises; resolve them all.
  transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  accountUpsert.mockImplementation(async ({ create }: { create: { code: string } }) => ({ code: create.code }));
  accountCreate.mockImplementation(async ({ data }: { data: { code: string } }) => ({ code: data.code }));
  accountFindMany.mockResolvedValue([]);
  tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
});

describe('ensureChartOfAccounts', () => {
  it('is a cheap no-op when the chart is already complete', async () => {
    // CONTRACT CHANGE, deliberate. This used to assert "Cash exists → stop,
    // without even loading the config". That fast path is exactly what let a
    // pack account added later never reach an existing tenant (see the
    // back-fill block below), so the guard is now "every pack code present".
    // It still costs ONE indexed query and still writes nothing.
    const all = await packCodes('us');
    accountFindMany.mockResolvedValue(all.map((code) => ({ code })));
    const r = await ensureChartOfAccounts('t1');
    expect(r).toEqual({ seeded: false, count: 0 });
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(accountCreate).not.toHaveBeenCalled();
    expect(accountFindMany).toHaveBeenCalledTimes(1);
    // Cash is the code posting actually depends on; it must be in the set.
    expect(all).toContain(CASH_CODE);
  });

  it('seeds the chart for a tenant with no accounts at all, including Cash', async () => {
    accountFindMany.mockResolvedValue([]);
    const r = await ensureChartOfAccounts('t1');
    expect(r.seeded).toBe(true);
    expect(r.count).toBeGreaterThan(0);
    const codes = accountCreate.mock.calls.map((c) => c[0].data.code);
    expect(codes).toContain('1000'); // the account posting depends on
  });

  it('scopes every write to the tenant, so one chart cannot leak into another', async () => {
    accountFindMany.mockResolvedValue([]);
    await ensureChartOfAccounts('t1');
    expect(accountCreate.mock.calls.length).toBeGreaterThan(0);
    for (const call of accountCreate.mock.calls) {
      expect(call[0].data.tenantId).toBe('t1');
    }
    // and the completeness read is tenant-scoped too
    expect(accountFindMany.mock.calls[0][0].where.tenantId).toBe('t1');
  });

  it('re-running cannot duplicate accounts, because it only writes what is missing', async () => {
    // The old guarantee came from upsert-by-(tenantId,code). It now comes from
    // diffing against what the tenant already has — same guarantee, and it no
    // longer rewrites rows it did not need to touch.
    const all = await packCodes('us');
    accountFindMany.mockResolvedValue(all.slice(0, 3).map((code) => ({ code })));
    await ensureChartOfAccounts('t1');
    const written = accountCreate.mock.calls.map((c) => c[0].data.code);
    expect(new Set(written).size).toBe(written.length);
    for (const had of all.slice(0, 3)) expect(written).not.toContain(had);
  });

  it('force re-upserts the whole chart even when it is complete (the onboarding endpoint)', async () => {
    accountFindMany.mockResolvedValue((await packCodes('us')).map((code) => ({ code })));
    const r = await ensureChartOfAccounts('t1', { force: true });
    expect(r.seeded).toBe(true);
    expect(accountUpsert).toHaveBeenCalled();
  });

  it('uses the student chart for a student tenant', async () => {
    accountFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue({ businessType: 'student', jurisdiction: 'us' });
    await ensureChartOfAccounts('t-student');
    const names = accountCreate.mock.calls.map((c) => c[0].data.name);
    expect(names).toContain('Tuition & Fees');
    expect(names).toContain('Scholarship / Grant Income');
  });

  it('uses the tenant jurisdiction chart (CA differs from US)', async () => {
    accountFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'ca' });
    await ensureChartOfAccounts('t-ca');
    const caCodes = accountCreate.mock.calls.map((c) => c[0].data.code);
    expect(caCodes).toContain('1000');
    expect(caCodes.length).toBeGreaterThan(0);
  });

  it('falls back to the US chart for an unknown jurisdiction rather than seeding nothing', async () => {
    accountFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'zz' });
    const r = await ensureChartOfAccounts('t-zz');
    expect(r.seeded).toBe(true);
    expect(accountCreate.mock.calls.map((c) => c[0].data.code)).toContain('1000');
  });

  it('still seeds when the tenant has no config row at all', async () => {
    accountFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue(null);
    const r = await ensureChartOfAccounts('t-noconfig');
    expect(r.seeded).toBe(true);
    expect(accountCreate.mock.calls.map((c) => c[0].data.code)).toContain('1000');
  });
});

describe('back-fills accounts added to a pack after the tenant was seeded', () => {
  /**
   * The Canadian demo tenant could not create an invoice:
   *
   *   "Tax liability account (2200) not found. Ensure chart of accounts is seeded."
   *
   * Maya's ledger held 2000, 2100 and 2400 — but not 2200 (PST/QST Payable),
   * which the CA pack gained after she was seeded. The old guard returned as
   * soon as Cash (1000) existed, so it never noticed a pack account that
   * appeared later. Any tenant seeded before any pack change is permanently
   * short of whatever that change added, and only discovers it when a posting
   * path fails loudly — invoicing, here, on the tenant used in every demo.
   *
   * So the guard has to mean "every pack account is present", not "this tenant
   * was seeded once". That costs one indexed findMany instead of one
   * findUnique, which is why the config load is no longer skippable.
   */
  const codesFor = (fn: typeof accountUpsert | typeof accountCreate) =>
    fn.mock.calls.map((c) => (c[0].create?.code ?? c[0].data?.code) as string);

  beforeEach(() => {
    tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'ca' });
  });

  it('creates a pack account the tenant is missing, without force', async () => {
    // Cash exists — the old code stopped here and 2200 stayed missing.
    accountFindMany.mockResolvedValue([{ code: '1000' }, { code: '1100' }, { code: '2100' }, { code: '4000' }]);
    const res = await ensureChartOfAccounts('t-partial');
    expect(codesFor(accountCreate), 'the missing pack code was not written').toContain('2200');
    expect(res.seeded).toBe(true);
  });

  it('writes ONLY the missing codes, never the ones already there', async () => {
    accountFindMany.mockResolvedValue([{ code: '1000' }, { code: '1100' }, { code: '2100' }, { code: '4000' }]);
    await ensureChartOfAccounts('t-partial');
    const written = codesFor(accountCreate);
    for (const had of ['1000', '1100', '2100', '4000']) {
      expect(written, `rewrote an existing account: ${had}`).not.toContain(had);
    }
  });

  it('does not rename or retype an account the user customised', async () => {
    // Back-fill must be additive. An upsert with an update clause would
    // silently overwrite a renamed account on every expense write.
    accountFindMany.mockResolvedValue([{ code: '1000' }, { code: '1100' }, { code: '2100' }, { code: '4000' }]);
    await ensureChartOfAccounts('t-partial');
    expect(accountUpsert, 'used upsert (updates existing rows) instead of create').not.toHaveBeenCalled();
  });

  it('no-ops when the tenant already has every pack account', async () => {
    // This runs on every expense and invoice write; it must stay one query.
    const all = await packCodes('ca');
    accountFindMany.mockResolvedValue(all.map((code) => ({ code })));
    const res = await ensureChartOfAccounts('t-complete');
    expect(res).toEqual({ seeded: false, count: 0 });
    expect(accountCreate).not.toHaveBeenCalled();
  });

  it('force still reseeds names and types, because that is an explicit reset', async () => {
    // /accounts/seed-jurisdiction passes force:true to repair a chart.
    accountFindMany.mockResolvedValue([]);
    await ensureChartOfAccounts('t-force', { force: true });
    expect(accountUpsert, 'force must upsert so it can correct names').toHaveBeenCalled();
  });
});
