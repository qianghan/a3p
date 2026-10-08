// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));

import { memDb, clone } from '@/__tests__/helpers/mem-db';
import { tenantReq } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { POST as ARCHIVE } from '@/app/api/v1/agentbook-expense/expenses/[id]/archive/route';
import { POST as UNARCHIVE } from '@/app/api/v1/agentbook-expense/expenses/[id]/unarchive/route';
import { GET as ESTIMATE } from '@/app/api/v1/agentbook-tax/tax/estimate/route';
import { GET as PNL } from '@/app/api/v1/agentbook-tax/reports/pnl/route';
import { GET as OVERVIEW } from '@/app/api/v1/agentbook-core/dashboard/overview/route';

const RANGE = 'startDate=2026-01-01&endDate=2026-06-30';
const snapshot = async () => ({
  estimateAccrual: await (await ESTIMATE(tenantReq(`/api/v1/agentbook-tax/tax/estimate?${RANGE}&basis=accrual`))).text(),
  estimateCash: await (await ESTIMATE(tenantReq(`/api/v1/agentbook-tax/tax/estimate?${RANGE}&basis=cash`))).text(),
  pnlAccrual: await (await PNL(tenantReq(`/api/v1/agentbook-tax/reports/pnl?${RANGE}&basis=accrual`))).text(),
  pnlCash: await (await PNL(tenantReq(`/api/v1/agentbook-tax/reports/pnl?${RANGE}&basis=cash`))).text(),
  overview: await (await OVERVIEW(tenantReq('/api/v1/agentbook-core/dashboard/overview'))).text(),
  journalEntries: clone(memDb.table('abJournalEntry').rows),
  journalLines: clone(memDb.table('abJournalLine').rows),
});

/** Reads e2's archivedAt straight from the mem-db store (not via a route). */
const archivedAt = () => memDb.table('abExpense').rows.find((r) => r.id === 'e2')!.archivedAt;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('archive is a view preference, never a bookkeeping event (spec §7)', () => {
  it('archive → unarchive → archive leaves journal, tax estimate, P&L and dashboard byte-identical', async () => {
    const before = await snapshot();
    const ctx = { params: Promise.resolve({ id: 'e2' }) };
    expect((await ARCHIVE(tenantReq('/api/v1/agentbook-expense/expenses/e2/archive', 't1', { method: 'POST' }), ctx)).status).toBe(200);
    expect(archivedAt()).not.toBeNull();
    const archived = await snapshot();
    expect((await UNARCHIVE(tenantReq('/api/v1/agentbook-expense/expenses/e2/unarchive', 't1', { method: 'POST' }), ctx)).status).toBe(200);
    expect(archivedAt()).toBeNull();
    expect((await ARCHIVE(tenantReq('/api/v1/agentbook-expense/expenses/e2/archive', 't1', { method: 'POST' }), ctx)).status).toBe(200);
    expect(archivedAt()).not.toBeNull();
    const after = await snapshot();
    expect(archived).toEqual(before);
    expect(after).toEqual(before);
    expect(memDb.table('abJournalEntry').writes).toEqual([]);
    expect(memDb.table('abJournalLine').writes).toEqual([]);
  });
});
