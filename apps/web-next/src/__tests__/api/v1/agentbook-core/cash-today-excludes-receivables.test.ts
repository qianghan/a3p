// @vitest-environment node
/**
 * "Cash today" (desktop overview AND mobile/home — one helper) is cash and
 * bank money only. Creating an invoice posts Dr 1100 A/R; that is money the
 * client owes, already shown as Outstanding, so it must not ALSO appear in
 * cash. Only the payment (Dr 1000 / Cr 1100) moves cash.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import type { MobileHome } from '@/lib/mobile/types';
import { GET as HOME } from '@/app/api/v1/agentbook-core/mobile/home/route';
import { GET as OVERVIEW } from '@/app/api/v1/agentbook-core/dashboard/overview/route';

const homeCash = async (tenant: string) =>
  (await json<{ data: MobileHome }>(await HOME(tenantReq('/api/v1/agentbook-core/mobile/home', tenant)))).data.kpis.cashTodayCents;
const overviewCash = async (tenant: string) =>
  (await json<{ data: { cashToday: number | null } }>(await OVERVIEW(tenantReq('/api/v1/agentbook-core/dashboard/overview', tenant)))).data.cashToday;

/** Accounts carry their journal lines embedded (mem-db ignores include/select). */
function account(id: string, tenantId: string, code: string, accountType: string, lines: Array<[number, number]> = []): Row {
  return {
    id, tenantId, code, name: id, accountType, isActive: true,
    journalLines: lines.map(([debitCents, creditCents]) => ({ debitCents, creditCents })),
  };
}

function withAccounts(extra: Row[]) {
  const seed = fullSeed();
  seed.abAccount = [...(seed.abAccount ?? []), ...extra];
  memDb.reset(seed);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('cash today excludes accounts receivable', () => {
  it('an unpaid invoice (Dr 1100 A/R) does not inflate cash on overview or mobile/home', async () => {
    memDb.reset(fullSeed());
    const before = { overview: await overviewCash('t1'), home: await homeCash('t1') };
    expect(before).toEqual({ overview: 460100, home: 460100 });

    // Invoice for 250 000 posted: Dr 1100 A/R / Cr 4000 revenue.
    withAccounts([account('acc-ar', 't1', '1100', 'asset', [[250000, 0]])]);
    expect(await overviewCash('t1')).toBe(460100);
    expect(await homeCash('t1')).toBe(460100);
  });

  it('after the payment, cash rises by exactly the payment (Dr 1000 / Cr 1100)', async () => {
    // A tenant with only an invoice for 100 000, then 40 000 paid against it.
    withAccounts([
      account('t9-cash', 't9', '1000', 'asset', [[40000, 0]]),
      account('t9-ar', 't9', '1100', 'asset', [[100000, 0], [0, 40000]]),
      account('t9-rev', 't9', '4000', 'revenue', [[0, 100000]]),
    ]);
    expect(await overviewCash('t9')).toBe(40000);
    expect(await homeCash('t9')).toBe(40000);
  });

  it('bank (1200) and savings (1300) count; AU term deposits (1400) do not', async () => {
    withAccounts([
      account('t8-cash', 't8', '1000', 'asset', [[1000, 0]]),
      account('t8-bank', 't8', '1200', 'asset', [[20000, 0]]),
      account('t8-sav', 't8', '1300', 'asset', [[300000, 0]]),
      account('t8-td', 't8', '1400', 'asset', [[5000000, 0]]),
      account('t8-ar', 't8', '1100', 'asset', [[70000, 0]]),
    ]);
    expect(await overviewCash('t8')).toBe(321000);
    expect(await homeCash('t8')).toBe(321000);
  });

  it('a tenant with no cash or bank account has NO cash figure (null), not a silent $0', async () => {
    withAccounts([account('t7-ar', 't7', '1100', 'asset', [[90000, 0]])]);
    expect(await overviewCash('t7')).toBeNull();
    expect(await homeCash('t7')).toBeNull();
    // An inactive cash account is not a cash account either.
    withAccounts([{ ...account('t6-cash', 't6', '1000', 'asset', [[500, 0]]), isActive: false }]);
    expect(await homeCash('t6')).toBeNull();
  });
});
