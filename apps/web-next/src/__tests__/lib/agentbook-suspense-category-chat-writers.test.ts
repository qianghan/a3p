// @vitest-environment node
/**
 * The 6999 "Uncategorized Expenses" suspense account is an internal posting
 * target, never a category (see lib/agentbook-expense-category.ts). The HTTP
 * write paths reject it; these are the chat-side writers that pick a category
 * by NAME or CODE and so could still land on it:
 *
 *   - the LLM auto-categorizer (it chose from a list that included 6999)
 *   - the bot agent's `expense.categorize` step
 *   - the shared list filter the Telegram pickers / bot context use
 *
 * Stamping 6999 on expense.categoryId would hide a still-unclassified expense
 * from the needs-category filter, the watchdog and reports (all `categoryId: null`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
const backfill = vi.fn(async () => 'je-new');
vi.mock('@/lib/agentbook-expense-ledger', () => ({
  backfillExpenseJournalEntry: (...a: unknown[]) => backfill(...(a as [])),
}));

import { memDb } from '@/__tests__/helpers/mem-db';
import { fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';
import { executeStep, type BotContext, type ActiveExpense } from '@/lib/agentbook-bot-agent';
import { assignableCategoryWhere } from '@/lib/agentbook-expense-category';

const expenseRow = (id: string) => memDb.table('abExpense').findFirst({ where: { id } });

beforeEach(() => {
  memDb.reset(fullSeed());
  backfill.mockClear();
});

describe('assignableCategoryWhere — the list every category picker draws from', () => {
  it("is the tenant's active expense accounts minus the 6999 suspense account", async () => {
    const rows = await memDb.table('abAccount').findMany({ where: assignableCategoryWhere('t1') });
    expect(rows.map((r) => r.id).sort()).toEqual(['acc-fuel', 'acc-meals']);
  });
});

describe('LLM auto-categorizer', () => {
  const llmSays = (categoryName: string, confidence = 0.97) => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ categoryName, confidence, reason: 'x' }) }] } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  beforeEach(() => vi.stubEnv('GEMINI_API_KEY', 'test-key'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('control: a real category from the model is applied (the harness reaches the write)', async () => {
    llmSays('Meals');
    const out = await autoCategorizeForTenant('t1', { force: true });
    expect(out.appliedCount).toBeGreaterThan(0);
    expect((await expenseRow('e5'))?.categoryId).toBe('acc-meals');
  });

  it('never offers 6999 to the model, and never applies it even if the model names it anyway', async () => {
    const fetchMock = llmSays('Uncategorized');
    const out = await autoCategorizeForTenant('t1', { force: true });

    const prompts = fetchMock.mock.calls.map((c) => JSON.stringify((c as unknown[])[1]));
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).not.toContain('• Uncategorized');
    expect(out.appliedCount).toBe(0);
    expect(out.pending).toEqual([]);
    expect((await expenseRow('e5'))?.categoryId).toBeNull();
    expect((await expenseRow('e6'))?.categoryId).toBeNull();
    expect(memDb.table('abExpense').writes).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });
});

describe('bot agent expense.categorize step', () => {
  const active = (): ActiveExpense => ({
    id: 'e5', amountCents: 3500, currency: 'CAD', date: new Date('2026-06-18'), description: 'Coffee',
    vendorName: 'Cafe', vendorId: 'v-cafe', categoryId: null, categoryName: null, isPersonal: false, status: 'pending_review',
  });
  const ctx = (): BotContext => ({
    tenantId: 't1',
    active: active(),
    // A caller that forgot to filter: the step must still refuse 6999.
    categories: [
      { id: 'acc-meals', name: 'Meals', code: '5200' },
      { id: 'acc-susp', name: 'Uncategorized', code: '6999' },
    ],
  });
  const step = (categoryName: string) => ({ id: 's1', skill: 'expense.categorize', args: { categoryName }, dependsOn: [] });

  it('control: a real category is applied, learned and stamped', async () => {
    expect(await executeStep(step('Meals'), ctx())).toMatchObject({ success: true });
    expect((await expenseRow('e5'))?.categoryId).toBe('acc-meals');
  });

  it('refuses the 6999 suspense account: step fails, nothing written, expense stays uncategorized', async () => {
    const r = await executeStep(step('Uncategorized'), ctx());
    expect(r).toMatchObject({ stepId: 's1', success: false });
    expect(memDb.table('abExpense').writes).toEqual([]);
    expect(memDb.table('abPattern').writes).toEqual([]);
    expect(memDb.table('abVendor').writes).toEqual([]);
    expect((await expenseRow('e5'))?.categoryId).toBeNull();
  });
});
