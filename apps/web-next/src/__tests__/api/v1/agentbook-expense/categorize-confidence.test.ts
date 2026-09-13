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

/**
 * `source` now SELECTS POLICY — it decides whether the caller is allowed to
 * name its own confidence — so it can no longer be an unvalidated string off
 * the request body. An unknown value used to fall through to the 1.0 / 0.95
 * user-correction path on the pattern while STILL honouring the body's
 * confidence on the expense, and was persisted verbatim to AbPattern.source.
 */
describe('POST …/categorize — `source` is whitelisted, not echoed', () => {
  const patternSource = () =>
    (patternUpsert.mock.calls[0][0] as { update: { source: string }; create: { source: string } });

  it('treats an unknown source as a user correction and ignores its confidence', async () => {
    await call({ categoryId: 'c-rent', source: 'totally_made_up', confidence: 0.3 });
    expect(expenseConfidence()).toBe(1.0);
    expect(patternConfidence().update.confidence).toBe(0.95);
    expect(patternSource().update.source).toBe('user_corrected');
    expect(patternSource().create.source).toBe('user_corrected');
  });

  it('stores the whitelisted value, never the raw body string', async () => {
    await call({ categoryId: 'c-rent', source: 'AUTO_CATEGORIZE' });
    expect(patternSource().create.source).toBe('user_corrected');
  });

  it('a missing source is a user correction and its confidence is ignored too', async () => {
    await call({ categoryId: 'c-rent', confidence: 0.2 });
    expect(expenseConfidence()).toBe(1.0);
    expect(patternSource().create.source).toBe('user_corrected');
  });

  it('auto_categorize is the one source that may name its own confidence', async () => {
    await call({ categoryId: 'c-rent', source: 'auto_categorize', confidence: 0.7 });
    expect(expenseConfidence()).toBe(0.7);
    expect(patternSource().create.source).toBe('auto_categorize');
  });

  it("stores the UI's 'user' source verbatim and ignores its confidence", async () => {
    await call({ categoryId: 'c-rent', source: 'user', confidence: 0.3 });
    expect(expenseConfidence()).toBe(1.0);
    expect(patternConfidence().update.confidence).toBe(0.95);
    expect(patternSource().update.source).toBe('user');
    expect(patternSource().create.source).toBe('user');
  });

  it("stores the banner's 'agent_confirmed' source verbatim and ignores its confidence", async () => {
    await call({ categoryId: 'c-rent', source: 'agent_confirmed', confidence: 0.3 });
    expect(expenseConfidence()).toBe(1.0);
    expect(patternConfidence().update.confidence).toBe(0.95);
    expect(patternSource().update.source).toBe('agent_confirmed');
    expect(patternSource().create.source).toBe('agent_confirmed');
  });

  it('an unknown source still normalizes to user_corrected', async () => {
    await call({ categoryId: 'c-rent', source: 'zzz' });
    expect(patternSource().create.source).toBe('user_corrected');
  });
});

/**
 * The category + ledger writes commit BEFORE vendor-pattern learning runs.
 * When two concurrent requests for the same vendor race on the
 * tenantId_vendorPattern upsert — which the chat categorize skill now
 * triggers by issuing several writes in parallel — Prisma throws a P2002
 * unique-violation on the loser. That used to bubble up as a 500 even though
 * the category and ledger were already applied, so the caller reported the
 * row as failed. Learning is best-effort: the route must still return
 * success.
 */
describe('POST …/categorize — vendor-pattern learning is best-effort', () => {
  it('still returns success when abPattern.upsert rejects with a P2002 unique-violation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      patternUpsert.mockImplementationOnce(async () => {
        const err = new Error('Unique constraint failed on the fields: (`tenantId`,`vendorPattern`)');
        (err as { code?: string }).code = 'P2002';
        throw err;
      });

      const res = await call({ categoryId: 'c-rent' });
      const json = (await res.json()) as { success: boolean; data: unknown };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toBeTruthy();
      expect(expenseUpdate).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
