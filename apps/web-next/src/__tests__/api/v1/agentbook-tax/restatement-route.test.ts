/**
 * PR 2c — the real restatement Next handlers over the stateful fake ledger:
 * preview is read-only, apply writes the amend pair once, the tenant comes
 * from the session (another tenant's rows are never touched), bad years 400,
 * non-registrants 422.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ fake: null as any, tenant: 't1' }));
vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }) }));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: h.tenant }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import { GET, POST } from '@/app/api/v1/agentbook-tax/restatement/route';

const get = (qs: string) => GET(new NextRequest(`http://x/api/v1/agentbook-tax/restatement${qs}`));
const post = (body: unknown) =>
  POST(new NextRequest('http://x/api/v1/agentbook-tax/restatement', { method: 'POST', body: JSON.stringify(body) }));

function seedLegacy(id: string, tenantId = 't1', debitAccountId = 'acct-meals') {
  h.fake.seedBookedExpense({ id, tenantId, amountCents: 11000, date: new Date('2026-03-10T12:00:00Z'), debitAccountId });
  Object.assign(h.fake.state.expenses.find((e: any) => e.id === id), { taxCode: null, recoverableTaxCents: 0, taxAmountCents: 1000 });
}

beforeEach(() => {
  h.fake = createFakeLedgerDb();
  h.tenant = 't1';
  h.fake.state.tenantConfigs.push(
    { userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true },
    { userId: 't2', jurisdiction: 'au', region: 'NSW', gstRegistered: true },
  );
  h.fake.state.accounts.push({ id: 'acct-t2-gst', tenantId: 't2', code: '2100', accountType: 'liability', isActive: true });
});

describe('GET/POST /agentbook-tax/restatement', () => {
  it('preview reports the delta and writes nothing; apply restates once; a second apply is a no-op', async () => {
    seedLegacy('e1');
    const p = await (await get('?year=2026')).json();
    expect(p.data.counts.eligible).toBe(1);
    expect(p.data.expenseDeltaCents).toBe(-1000);
    expect(p.data.eligible[0]).toMatchObject({ expenseId: 'e1', taxCode: 'GST', recoverableTaxCents: 1000 });
    expect(h.fake.state.entries.length).toBe(1);

    const a = await post({ year: 2026 });
    expect(a.status).toBe(200);
    const body = await a.json();
    expect(body.data.restated.map((r: any) => r.expenseId)).toEqual(['e1']);
    expect(h.fake.state.entries.map((e: any) => e.sourceType)).toEqual(['expense', 'expense_amend_reversal', 'expense_amend']);
    expect(h.fake.netByAccount()).toMatchObject({ 'acct-meals': 10000, 'acct-gst': 1000, 'acct-cash': -11000 });

    const again = await (await post({ year: 2026 })).json();
    expect(again.data.restated).toEqual([]);
    expect(h.fake.state.entries.length).toBe(3);
  });

  it('is scoped to the session tenant', async () => {
    seedLegacy('theirs', 't2', 'acct-t2-meals');
    const p = await (await get('?year=2026')).json();
    expect(p.data.counts.eligible).toBe(0);
    await post({ year: 2026 });
    expect(h.fake.state.expenses[0].taxCode).toBeNull();
    expect(h.fake.state.entries.length).toBe(1);
  });

  it('rejects a malformed year with 400', async () => {
    expect((await get('?year=abc')).status).toBe(400);
    expect((await post({ year: 1990 })).status).toBe(400);
  });

  it('a non-registrant gets 422 not_registered on apply and nothing is written', async () => {
    h.fake.state.tenantConfigs[0].gstRegistered = false;
    seedLegacy('e1');
    const r = await post({ year: 2026 });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe('not_registered');
    expect(h.fake.state.entries.length).toBe(1);
  });
});
