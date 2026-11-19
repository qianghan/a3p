// @vitest-environment node
/**
 * PR 2b (carried T3 minor): the typed AU-registrant path through POST /expenses with the REAL
 * withHttpIdempotency wrapper. The same Idempotency-Key twice → exactly one expense, one journal
 * entry (3 lines), recoverable 1000, and the replay returns the original id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// The wrapper's cache table keys on a compound unique (tenantId_key_endpoint) the in-memory DB
// does not model, so it gets a tiny map; everything else is the shared mem-db.
const idemRows = new Map<string, Record<string, unknown>>();
const k = (w: { tenantId_key_endpoint: { tenantId: string; key: string; endpoint: string } }) =>
  `${w.tenantId_key_endpoint.tenantId}|${w.tenantId_key_endpoint.key}|${w.tenantId_key_endpoint.endpoint}`;
const idemTable = {
  findUnique: async ({ where }: { where: Parameters<typeof k>[0] }) => idemRows.get(k(where)) ?? null,
  upsert: async ({ where, create, update }: { where: Parameters<typeof k>[0]; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const row = idemRows.has(k(where)) ? { ...idemRows.get(k(where)), ...update } : create;
    idemRows.set(k(where), row);
    return row;
  },
};
vi.mock('@naap/database', async () => {
  const { memDb } = await import('@/__tests__/helpers/mem-db');
  const prisma = new Proxy(memDb as object, {
    get: (t, p) => (p === 'abHttpIdempotencyKey' ? idemTable : (t as Record<string | symbol, unknown>)[p]),
  });
  return { prisma };
});
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-auto-categorize', () => ({ autoCategorizeForTenant: vi.fn(), getPendingSuggestions: vi.fn(async () => []) }));
vi.mock('@/lib/agentbook-suggest-category', () => ({ rememberVendorCategory: vi.fn(async () => true) }));

import { NextRequest } from 'next/server';
import { memDb } from '@/__tests__/helpers/mem-db';
import { TENANT_HEADER, json } from '@/__tests__/helpers/route-request';
import { POST } from '@/app/api/v1/agentbook-expense/expenses/route';

beforeEach(() => {
  idemRows.clear();
  memDb.reset(
    {
      abAccount: [
        { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
        { id: 'acc-gst', tenantId: 't1', code: '2100', name: 'GST/HST Payable', accountType: 'liability', isActive: true },
        { id: 'acc-office', tenantId: 't1', code: '5200', name: 'Office Supplies', accountType: 'expense', isActive: true },
        { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
      ],
      abTenantConfig: [{ id: 'cfg', userId: 't1', currency: 'AUD', jurisdiction: 'au', region: 'NSW', gstRegistered: true }],
      abVendor: [],
      abFiscalPeriod: [],
    },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']] } },
  );
});

const BODY = { amountCents: 11000, vendor: 'Officeworks', categoryId: 'acc-office', taxCode: 'GST', taxInclusive: true, date: '2026-06-10' };
function post(key: string) {
  return POST(new NextRequest(new URL('/api/v1/agentbook-expense/expenses', 'http://test.local'), {
    method: 'POST',
    headers: { [TENANT_HEADER]: 't1', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(BODY),
  }));
}

describe('POST /expenses typed replay (AU registrant)', () => {
  it('same Idempotency-Key twice → one expense, one 3-line entry, recoverable 1000', async () => {
    const a = await json<{ data: { id: string } }>(await post('key-1'));
    const b = await json<{ data: { id: string } }>(await post('key-1'));
    expect(b.data.id).toBe(a.data.id);
    const expenses = memDb.table('abExpense').rows;
    expect(expenses.map((e) => [e.amountCents, e.taxCode, e.recoverableTaxCents])).toEqual([[11000, 'GST', 1000]]);
    const entries = memDb.table('abJournalEntry').rows;
    expect(entries).toHaveLength(1);
    const lines = memDb.table('abJournalLine').rows.filter((l) => l.entryId === entries[0].id);
    expect(Object.fromEntries(lines.map((l) => [l.accountId, [l.debitCents, l.creditCents]])))
      .toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
  });
});
