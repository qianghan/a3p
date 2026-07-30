/**
 * Chart-of-accounts seed-on-demand.
 *
 * The chart was created ONLY by the onboarding flow, so a tenant who skipped
 * onboarding had no Cash (1000) account and every posting path silently skipped
 * the ledger. `ensureChartOfAccounts` closes that by seeding on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const accountFindFirst = vi.fn();
const accountUpsert = vi.fn();
const tenantFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abAccount: {
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      upsert: (...a: unknown[]) => accountUpsert(...a),
    },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { ensureChartOfAccounts, CASH_CODE } from '../agentbook-chart-of-accounts';

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction receives an array of upsert promises; resolve them all.
  transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  accountUpsert.mockImplementation(async ({ create }: { create: { code: string } }) => ({ code: create.code }));
  tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
});

describe('ensureChartOfAccounts', () => {
  it('is a cheap no-op when the Cash account already exists', async () => {
    accountFindFirst.mockResolvedValue({ id: 'acct-cash' });
    const r = await ensureChartOfAccounts('t1');
    expect(r).toEqual({ seeded: false, count: 0 });
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(tenantFindUnique).not.toHaveBeenCalled(); // didn't even load config
    // and it checked the code that actually gates posting
    expect(accountFindFirst.mock.calls[0][0].where.code).toBe(CASH_CODE);
  });

  it('seeds the chart when Cash is missing, including Cash itself', async () => {
    accountFindFirst.mockResolvedValue(null);
    const r = await ensureChartOfAccounts('t1');
    expect(r.seeded).toBe(true);
    expect(r.count).toBeGreaterThan(0);
    const codes = accountUpsert.mock.calls.map((c) => c[0].create.code);
    expect(codes).toContain('1000'); // the account posting depends on
  });

  it('upserts by tenantId+code, so re-running cannot duplicate accounts', async () => {
    accountFindFirst.mockResolvedValue(null);
    await ensureChartOfAccounts('t1');
    for (const call of accountUpsert.mock.calls) {
      expect(call[0].where).toHaveProperty('tenantId_code');
      expect(call[0].where.tenantId_code.tenantId).toBe('t1');
    }
  });

  it('force re-upserts the whole chart even when Cash exists (the onboarding endpoint)', async () => {
    accountFindFirst.mockResolvedValue({ id: 'acct-cash' });
    const r = await ensureChartOfAccounts('t1', { force: true });
    expect(r.seeded).toBe(true);
    expect(accountUpsert).toHaveBeenCalled();
  });

  it('uses the student chart for a student tenant', async () => {
    accountFindFirst.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue({ businessType: 'student', jurisdiction: 'us' });
    await ensureChartOfAccounts('t-student');
    const names = accountUpsert.mock.calls.map((c) => c[0].create.name);
    expect(names).toContain('Tuition & Fees');
    expect(names).toContain('Scholarship / Grant Income');
  });

  it('uses the tenant jurisdiction chart (CA differs from US)', async () => {
    accountFindFirst.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'ca' });
    await ensureChartOfAccounts('t-ca');
    const caCodes = accountUpsert.mock.calls.map((c) => c[0].create.code);
    expect(caCodes).toContain('1000');
    expect(caCodes.length).toBeGreaterThan(0);
  });

  it('falls back to the US chart for an unknown jurisdiction rather than seeding nothing', async () => {
    accountFindFirst.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'zz' });
    const r = await ensureChartOfAccounts('t-zz');
    expect(r.seeded).toBe(true);
    expect(accountUpsert.mock.calls.map((c) => c[0].create.code)).toContain('1000');
  });

  it('still seeds when the tenant has no config row at all', async () => {
    accountFindFirst.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue(null);
    const r = await ensureChartOfAccounts('t-noconfig');
    expect(r.seeded).toBe(true);
    expect(accountUpsert.mock.calls.map((c) => c[0].create.code)).toContain('1000');
  });
});
