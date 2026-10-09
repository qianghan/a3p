/**
 * POST /expenses/:id/confirm — a SOFT-DELETED expense is 404, as on every other
 * [id] route.
 *
 * The route looked the expense up by (id, tenantId) only, so a document deleted
 * on another device (DELETE reversed its books and stamped deletedAt) could
 * still be confirmed from a stale screen — and confirm BOOKS a categorized
 * business expense, putting the money DELETE removed back on the books.
 *
 * Real route against fake-ledger-db (applies `where`, so a missing deletedAt
 * filter is visible).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ fake: null as any, events: [] as unknown[] }));

vi.mock('@naap/database', () => ({
  prisma: new Proxy({}, { get: (_t, p) => (p === 'abEvent' ? { create: async (a: unknown) => h.events.push(a) } : h.fake.db[p as string]) }),
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 't1' })),
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

const JAN = new Date('2026-01-15T12:00:00.000Z');

async function confirm(id = 'exp-1') {
  const route = await import('@/app/api/v1/agentbook-expense/expenses/[id]/confirm/route');
  const res = await route.POST(
    new NextRequest(`http://x/api/v1/agentbook-expense/expenses/${id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: await res.json() };
}

const pendingDraft = (deletedAt: Date | null) => ({
  id: 'exp-1', tenantId: 't1', amountCents: 4200, date: JAN, description: 'Coffee', status: 'pending_review',
  categoryId: 'acct-meals', isPersonal: false, journalEntryId: null, deletedAt, vendorId: null,
});

beforeEach(() => {
  h.fake = createFakeLedgerDb();
  h.events = [];
});

describe('POST /expenses/:id/confirm and deletedAt', () => {
  it('a soft-deleted expense is 404: not confirmed, nothing booked, no event', async () => {
    h.fake.state.expenses.push(pendingDraft(JAN));
    const { status, json } = await confirm();
    expect(status).toBe(404);
    expect(json).toEqual({ success: false, error: 'Expense not found' });
    expect(h.fake.state.expenses[0].status).toBe('pending_review');
    expect(h.fake.state.expenses[0].journalEntryId).toBeNull();
    expect(h.fake.state.entries).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('positive control: a live pending draft is confirmed and booked once', async () => {
    h.fake.state.expenses.push(pendingDraft(null));
    const { status } = await confirm();
    expect(status).toBe(200);
    expect(h.fake.state.expenses[0].status).toBe('confirmed');
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 4200, 'acct-cash': -4200 });
  });
});
