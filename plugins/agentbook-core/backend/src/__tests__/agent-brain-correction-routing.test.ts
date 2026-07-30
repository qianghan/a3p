import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * MONEY-BUG REGRESSION GUARD — canonical eval run 30578028815 (2026-07-30).
 *
 * Thread t-maya-amount-correction:
 *     "lunch $42"           -> record-expense   (correct)
 *     "actually it was $52" -> record-expense   (WRONG)
 *
 * Routing the correction to record-expense booked a SECOND expense, so the
 * user's books showed $42 + $52 = $94 for one lunch. A silent double-count
 * that also inflated their deductions.
 *
 * Root cause: correction detection existed ONLY in the Telegram adapter, which
 * set `req.feedback` before calling the brain. The brain entered its correction
 * path `if (feedback)` only, so web / API / MCP / this eval never reached it and
 * the follow-up was classified as a brand-new intent.
 *
 * These tests assert the fix at the boundary that actually costs money: which
 * skill gets EXECUTED. `classifyOnly` is deliberately stubbed to return
 * record-expense — i.e. the classifier still sees "$52" and still wants to book
 * a new expense — so the only way these pass is if the correction path
 * intercepts ahead of it.
 */

const TRAVEL_ACCOUNT = { id: 'acct-travel', name: 'Travel', accountType: 'expense', isActive: true };

const threadState: { turns: any[] } = { turns: [] };

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => ({
        id: 'thread-1',
        lastActiveAt: new Date(),
        turns: threadState.turns,
        activeEntities: [],
        parkedFills: [],
      })),
      create: vi.fn(async () => ({ id: 'thread-1', turns: [], activeEntities: [], parkedFills: [] })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'sess-1', version: 1, plan: [], stepResults: [], undoStack: [] })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
    abAccount: {
      findFirst: vi.fn(async ({ where }: any) => {
        const wanted = where?.name?.contains?.toLowerCase?.() ?? '';
        return wanted && 'travel'.includes(wanted) ? TRAVEL_ACCOUNT : null;
      }),
    },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

const RECORD_EXPENSE = {
  name: 'record-expense',
  endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/expenses' },
  confirmBefore: false,
};
const EDIT_EXPENSE = {
  name: 'edit-expense',
  endpoint: { method: 'PUT', url: '/api/v1/agentbook-expense/expenses/:id' },
  confirmBefore: true,
};

/** Simulates "the previous turn recorded an expense" in this channel's thread. */
function withPriorTurn(intent: string | undefined, entityId?: string) {
  threadState.turns = [
    { role: 'user', text: 'lunch $42', at: new Date().toISOString() },
    { role: 'bot', text: 'Recorded $42.00 lunch', at: new Date().toISOString(), intent, entityId },
  ];
}

function buildCorrectionContext(text: string) {
  return buildTestContext({
    text,
    tenantId: 'tenant-maya',
    channel: 'web',
    // The classifier still wants to book a NEW expense — the bug's behaviour.
    classification: { selectedSkill: RECORD_EXPENSE, extractedParams: { amountCents: 5200 } },
    skills: [RECORD_EXPENSE, EDIT_EXPENSE],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  threadState.turns = [];
});

describe('amount correction after a recorded expense (t-maya-amount-correction)', () => {
  it('edits the existing expense instead of booking a second one', async () => {
    withPriorTurn('record-expense');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalledTimes(1);
    const executed = (executeClassification as any).mock.calls[0][0];

    // The money assertion: never re-book.
    expect(executed.selectedSkill.name).toBe('edit-expense');
    expect(executed.selectedSkill.name).not.toBe('record-expense');
    expect(executed.extractedParams.amountCents).toBe(5200);

    expect(res.data?.skillUsed).toBe('edit-expense');
    expect(res.data?.message).toContain('$52');
  });

  it('applies the correction immediately rather than stalling on a confirm prompt', async () => {
    withPriorTurn('record-expense');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    // edit-expense carries confirmBefore: true, but a correction of the user's
    // own immediately-preceding turn is already explicit — gating it would
    // leave the wrong $42 on the books until a second message arrived.
    //
    // Assert the SKILL too, not just "something executed without a plan":
    // without it this passes when the correction is misrouted to
    // record-expense, which also executes and also has no plan.
    expect(executeClassification).toHaveBeenCalledTimes(1);
    expect((executeClassification as any).mock.calls[0][0].selectedSkill.name).toBe('edit-expense');
    expect(res.data?.plan).toBeFalsy();
  });
});

describe('category correction after a recorded expense (t-maya-tim-hortons)', () => {
  it('recategorizes and names the new category back to the user', async () => {
    withPriorTurn('record-expense');
    const { req, ctx, executeClassification } = buildCorrectionContext(
      'no, that should be Travel category not Meals',
    );

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalledTimes(1);
    const executed = (executeClassification as any).mock.calls[0][0];
    expect(executed.selectedSkill.name).toBe('edit-expense');
    expect(executed.extractedParams.categoryId).toBe('acct-travel');

    // The eval failure was literally "reply is missing the required substring
    // Travel" — the recategorization was never confirmed back to the user.
    expect(res.data?.message).toContain('Travel');
  });

  it('does not silently claim success when the category does not exist', async () => {
    withPriorTurn('record-expense');
    const { req, ctx, executeClassification } = buildCorrectionContext(
      'no, that should be Nonexistent category',
    );

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    // Must fall through to normal handling — never report "Correction applied"
    // for an edit it could not make. (The pre-fix handleCorrection returned
    // applied:true even when it patched nothing at all.)
    const executed = (executeClassification as any).mock.calls[0]?.[0];
    expect(executed?.selectedSkill?.name).not.toBe('edit-expense');
    expect(res.data?.message ?? '').not.toMatch(/correction applied/i);
  });
});

describe('the correction must land on the expense the previous turn created', () => {
  it('targets that turn\'s expense id rather than "whatever is most recent"', async () => {
    withPriorTurn('record-expense', 'exp-the-lunch');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    const executed = (executeClassification as any).mock.calls[0][0];
    // Without an explicit id the executor falls back to "the most recent
    // expense", which it resolves with `orderBy: { date: 'desc' }` — the
    // expense DATE, not creation time. Anyone who records two expenses dated
    // the same day (routine) gets a nondeterministic tie, so the correction
    // could silently rewrite the amount on the WRONG expense. Passing the id
    // through makes the target exact.
    expect(executed.extractedParams.expenseId).toBe('exp-the-lunch');
  });

  it('still corrects when no id was captured, falling back to the last expense', async () => {
    withPriorTurn('record-expense', undefined);
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    const executed = (executeClassification as any).mock.calls[0][0];
    expect(executed.selectedSkill.name).toBe('edit-expense');
    // 'last' is the executor's documented "resolve the most recent one" token.
    expect(executed.extractedParams.expenseId ?? 'last').toBe('last');
  });
});

describe('a failing correction must never fall through to a new expense', () => {
  it('reports the failure instead of re-booking when the executor throws', async () => {
    withPriorTurn('record-expense', 'exp-the-lunch');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');
    (executeClassification as any).mockRejectedValueOnce(new Error('expense service down'));

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    // Falling through to normal classification here would book a SECOND
    // expense — the original bug, reached by a different route.
    expect(executeClassification).toHaveBeenCalledTimes(1);
    expect(res.data?.skillUsed).toBe('edit-expense');
    expect(res.data?.message).toMatch(/couldn't update/i);
    expect(res.data?.message).not.toMatch(/Updated —/);
  });

  it('reports the failure when the edit returns success:false', async () => {
    withPriorTurn('record-expense', 'exp-the-lunch');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');
    (executeClassification as any).mockResolvedValueOnce({
      selectedSkill: EDIT_EXPENSE,
      skillResponse: { success: false, error: 'Expense not found' },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.data?.message).toMatch(/couldn't update/i);
    expect(res.data?.message).toContain('Expense not found');
  });
});

describe('correction path must not hijack unrelated turns', () => {
  it('books a fresh expense when the previous turn was not an expense write', async () => {
    withPriorTurn('query-finance');
    const { req, ctx, executeClassification } = buildCorrectionContext('actually it was $52');

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    const executed = (executeClassification as any).mock.calls[0][0];
    expect(executed.selectedSkill.name).toBe('record-expense');
  });

  it('books a fresh expense on the first turn of a thread', async () => {
    threadState.turns = [];
    const { req, ctx, executeClassification } = buildCorrectionContext('lunch $42');

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    const executed = (executeClassification as any).mock.calls[0][0];
    expect(executed.selectedSkill.name).toBe('record-expense');
  });
});
