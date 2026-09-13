import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The categorize route hard-coded `confidence: 1.0` on the expense and `0.95`
 * on the learned vendor pattern, and had no way to say otherwise. That is
 * correct for the UI — a human picking a category IS certainty — but the
 * categorize-expenses skill calls the same route for a MODEL's guess, so every
 * auto-applied row was recorded as a user correction and taught the vendor
 * pattern at correction strength. The next expense from that vendor then
 * inherited a machine guess as though a human had confirmed it.
 *
 * These call the route and read the payloads it actually writes.
 */

vi.mock('server-only', () => ({}));

const expenseUpdate = vi.fn(async (a: { data: unknown }) => ({ id: 'e1', ...(a.data as object) }));
const patternUpsert = vi.fn(async () => ({}));
const vendorUpdate = vi.fn(async () => ({}));

vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: {
      findFirst: async () => ({ id: 'e1', tenantId: 't1', vendorId: 'v1' }),
      update: (...a: [{ data: unknown }]) => expenseUpdate(...a),
    },
    abVendor: {
      findUnique: async () => ({ id: 'v1', normalizedName: 'wework' }),
      update: (...a: unknown[]) => vendorUpdate(...(a as [])),
    },
    abPattern: { upsert: (...a: unknown[]) => patternUpsert(...(a as [])) },
  },
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }),
}));
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: vi.fn(async () => {}),
}));

import { POST } from '@/app/api/v1/agentbook-expense/expenses/[id]/categorize/route';

const params = Promise.resolve({ id: 'e1' });
const call = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://x/api/v1/agentbook-expense/expenses/e1/categorize', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params },
  );

const patternConfidence = () =>
  (patternUpsert.mock.calls[0][0] as { update: { confidence: number }; create: { confidence: number } });
const expenseConfidence = () => (expenseUpdate.mock.calls[0][0].data as { confidence: number }).confidence;

beforeEach(() => {
  expenseUpdate.mockClear();
  patternUpsert.mockClear();
  vendorUpdate.mockClear();
});

describe('POST /agentbook-expense/expenses/:id/categorize — whose certainty is this?', () => {
  it('a UI correction (no confidence sent) is still 1.0 / 0.95 — no regression', async () => {
    expect((await call({ categoryId: 'c-rent' })).status).toBe(200);
    expect(expenseConfidence()).toBe(1.0);
    expect(patternConfidence().update.confidence).toBe(0.95);
    expect(patternConfidence().create.confidence).toBe(0.95);
  });

  it("records the skill's own confidence on the expense, not user certainty", async () => {
    await call({ categoryId: 'c-rent', source: 'auto_categorize', confidence: 0.88 });
    expect(expenseConfidence()).toBe(0.88);
  });

  it('caps an auto_categorize pattern below what a human correction earns', async () => {
    // 0.99 from the model must not outrank a user's 0.95 on the same vendor.
    await call({ categoryId: 'c-rent', source: 'auto_categorize', confidence: 0.99 });
    expect(patternConfidence().update.confidence).toBe(0.92);
    expect(patternConfidence().create.confidence).toBe(0.92);
  });

  it('an auto_categorize pattern is never MORE confident than the row it came from', async () => {
    await call({ categoryId: 'c-rent', source: 'auto_categorize', confidence: 0.86 });
    expect(patternConfidence().update.confidence).toBe(0.86);
  });

  it('clamps a nonsense confidence instead of storing it', async () => {
    await call({ categoryId: 'c-rent', source: 'auto_categorize', confidence: 4 });
    expect(expenseConfidence()).toBe(1);
    expect(patternConfidence().update.confidence).toBe(0.92);
  });

  it('ignores a non-numeric confidence and falls back to 1.0', async () => {
    await call({ categoryId: 'c-rent', confidence: 'high' });
    expect(expenseConfidence()).toBe(1.0);
  });

  it('an explicit user_corrected source keeps 0.95 even when a confidence rides along', async () => {
    await call({ categoryId: 'c-rent', source: 'user_corrected', confidence: 0.5 });
    expect(patternConfidence().update.confidence).toBe(0.95);
  });
});
