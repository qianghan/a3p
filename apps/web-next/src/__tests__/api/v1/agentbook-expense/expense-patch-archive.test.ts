// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const audit = vi.fn(async () => {});
vi.mock('@/lib/agentbook-audit', () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { PATCH } from '@/app/api/v1/agentbook-expense/expenses/[id]/route';
import { POST as ARCHIVE } from '@/app/api/v1/agentbook-expense/expenses/[id]/archive/route';
import { POST as UNARCHIVE } from '@/app/api/v1/agentbook-expense/expenses/[id]/unarchive/route';
import { GET as LIST } from '@/app/api/v1/agentbook-expense/expenses/route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = async (id: string, body: unknown, tenant = 't1') => {
  const res = await PATCH(tenantReq(`/api/v1/agentbook-expense/expenses/${id}`, tenant, { method: 'PATCH', body }), ctx(id));
  return { status: res.status, body: await json<{ success: boolean; data: Record<string, unknown> }>(res) };
};
const archive = async (id: string, tenant = 't1') => {
  const res = await ARCHIVE(tenantReq(`/api/v1/agentbook-expense/expenses/${id}/archive`, tenant, { method: 'POST' }), ctx(id));
  return { status: res.status, body: await json<{ success: boolean; data: { id: string; archivedAt: string | null } }>(res) };
};
const unarchive = async (id: string, tenant = 't1') => {
  const res = await UNARCHIVE(tenantReq(`/api/v1/agentbook-expense/expenses/${id}/unarchive`, tenant, { method: 'POST' }), ctx(id));
  return { status: res.status, body: await json<{ success: boolean; data: { id: string; archivedAt: string | null } }>(res) };
};
const row = (id: string) => memDb.table('abExpense').findFirst({ where: { id } });
const listedIds = async (qs = '') =>
  (await json<{ data: Array<{ id: string }> }>(await LIST(tenantReq(`/api/v1/agentbook-expense/expenses${qs}`, 't1')))).data.map((r) => r.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
  audit.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('PATCH /expenses/[id] — vendor and date', () => {
  it('creates and links a new vendor, returning vendorName', async () => {
    const { status, body } = await patch('e6', { vendor: 'Starbucks Reserve' });
    expect(status).toBe(200);
    expect(body.data.vendorName).toBe('Starbucks Reserve');
    const v = await memDb.table('abVendor').findFirst({ where: { tenantId: 't1', normalizedName: 'starbucksreserve' } });
    expect(v).not.toBeNull();
    expect((await row('e6'))?.vendorId).toBe(v?.id);
  });

  it('reuses an existing vendor by normalized name and can clear it', async () => {
    await patch('e2', { vendor: 'SHELL' });
    expect((await row('e2'))?.vendorId).toBe('v-shell');
    await patch('e2', { vendor: '' });
    expect((await row('e2'))?.vendorId).toBeNull();
  });

  it('updates the date, and rejects an invalid date with 400 before writing anything', async () => {
    await patch('e1', { date: '2026-06-01' });
    expect((await row('e1'))?.date).toEqual(new Date('2026-06-01'));
    memDb.table('abExpense').writes = [];
    expect((await patch('e1', { date: 'not-a-date', amountCents: 1 })).status).toBe(400);
    expect(memDb.table('abExpense').writes).toEqual([]);
  });

  it('existing fields still work and are audited', async () => {
    await patch('e1', { amountCents: 4100, description: 'Fuel' });
    expect(await row('e1')).toMatchObject({ amountCents: 4100, description: 'Fuel' });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("cannot touch another tenant's expense", async () => {
    expect((await patch('e1', { vendor: 'Hijack' }, 't2')).status).toBe(404);
    expect((await row('e1'))?.vendorId).toBe('v-shell');
  });
});

describe('POST /expenses/[id]/archive and /unarchive', () => {
  it('archive hides the row from the default list and shows it under archived=true', async () => {
    const { status, body } = await archive('e1');
    expect(status).toBe(200);
    expect(body.data).toEqual({ id: 'e1', archivedAt: NOW.toISOString() });
    expect(await listedIds()).not.toContain('e1');
    expect(await listedIds('?archived=true')).toContain('e1');
  });

  it('is idempotent: a second archive returns the original timestamp and writes nothing', async () => {
    await archive('e1');
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const again = await archive('e1');
    expect(again.body.data.archivedAt).toBe(NOW.toISOString());
    expect(memDb.table('abExpense').writes.filter((w) => w.op === 'updateMany')).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('unarchive restores it; a second unarchive is a no-op', async () => {
    await archive('e1');
    const { status, body } = await unarchive('e1');
    expect(status).toBe(200);
    expect(body.data).toEqual({ id: 'e1', archivedAt: null });
    expect(await listedIds()).toContain('e1');
    expect((await unarchive('e1')).body.data).toEqual({ id: 'e1', archivedAt: null });
    expect(memDb.table('abExpense').writes.filter((w) => w.op === 'updateMany')).toHaveLength(2);
  });

  it('only writes archivedAt — nothing else on the row, nothing in the journal', async () => {
    await archive('e1');
    await unarchive('e1');
    for (const w of memDb.table('abExpense').writes) {
      expect(Object.keys((w.args as { data: Record<string, unknown> }).data)).toEqual(['archivedAt']);
    }
    expect(memDb.table('abJournalEntry').writes).toEqual([]);
    expect(memDb.table('abJournalLine').writes).toEqual([]);
  });

  it("404 for another tenant's id or a deleted expense; 401 without a session", async () => {
    expect((await archive('e1', 't2')).status).toBe(404);
    expect((await row('e1'))?.archivedAt).toBeNull();
    memDb.table('abExpense').rows.find((r) => r.id === 'e2')!.deletedAt = NOW;
    expect((await archive('e2')).status).toBe(404);
    expect((await unarchive('e7', 't2')).status).toBe(404);
    expect((await archive('e1', 'none')).status).toBe(401);
  });
});
