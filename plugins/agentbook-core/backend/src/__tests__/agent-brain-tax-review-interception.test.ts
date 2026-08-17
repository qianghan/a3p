import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgentMessage } from '../agent-brain.js';

// A pending destructive-action confirmation belonging to some OTHER skill,
// used by the collision test at the bottom of this file. `pendingClassification`
// is the shape agent-brain's Step 1 confirm branch executes via
// ctx.executeClassification.
const OTHER_PENDING_SESSION = {
  id: 'sess-other',
  version: 1,
  status: 'active',
  trigger: 'delete all my draft invoices',
  plan: [],
  currentStep: 0,
  stepResults: [],
  undoStack: [],
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  pendingConfirmation: {
    pendingClassification: { skill: { name: 'delete-invoices' }, params: {} },
    text: 'delete all my draft invoices',
    channel: 'telegram',
    attachments: [],
  },
};

// Same DB-free mock shape used by every other test file in this suite that
// drives handleAgentMessage end to end (see
// agent-brain-confidence-escalation.test.ts) — the backend test suite runs
// with no real DATABASE_URL (CI: "Backend Tests" job), so every table
// handleAgentMessageCore might touch on the "no active review" fall-through
// path (Step 1 session recovery, Step 1b tax-questionnaire recovery, Step 2
// context assembly) needs a stub here, independent of the checkActiveTaxReview
// interception this file is actually testing.
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({
        id: 'thread-1', lastActiveAt: new Date(), turns: [], activeEntities: [], parkedFills: [],
        ...args.data,
      })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: 'sess-new', version: 1, ...args.data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

function makeCtx(overrides: Partial<any> = {}) {
  return {
    callGemini: vi.fn(),
    classifyOnly: vi.fn(),
    classifyAndExecuteV1: vi.fn(),
    executeClassification: vi.fn(),
    checkActiveTaxReview: vi.fn().mockResolvedValue({ active: false }),
    answerTaxReview: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('agent-brain — tax review early interception', () => {
  it('when a review is active, routes the message to ctx.answerTaxReview and never calls classification', async () => {
    const ctx = makeCtx({
      checkActiveTaxReview: vi.fn().mockResolvedValue({ active: true, taxYear: 2025 }),
      answerTaxReview: vi.fn().mockResolvedValue({ message: 'Updated to $80,000.' }),
    });

    const result = await handleAgentMessage(
      { text: 'change income to 80000', tenantId: 't1', channel: 'web' } as any,
      ctx as any,
    );

    expect(ctx.answerTaxReview).toHaveBeenCalledWith('t1', 2025, 'change income to 80000');
    expect(ctx.classifyOnly).not.toHaveBeenCalled();
    expect(ctx.classifyAndExecuteV1).not.toHaveBeenCalled();
    expect(result.data.message).toContain('$80,000');
  });

  /**
   * The step-ordering bug. The interception block's comment always claimed it
   * ran "before an activeSession's own classification", but the code sat AFTER
   * Step 1 — so a tenant holding BOTH an in-progress tax review and an
   * unrelated pending destructive-action confirmation had their bare "yes"
   * claimed by Step 1, which executed that other action and never delivered
   * the reply to the review at all. Reachable on Telegram, whose adapter maps
   * an anchored ^yes$ to sessionAction='confirm' before agent-brain classifies
   * anything itself.
   */
  it('an in-progress tax review outranks an unrelated pending confirmation for the same "yes"', async () => {
    const { db } = await import('../db/client.js');
    // $executeRaw returns 1 in this file's mock, so updateSession()'s
    // optimistic lock SUCCEEDS — the pending-confirmation branch really would
    // reach ctx.executeClassification if it got there first. Without that the
    // assertion below would pass for the wrong reason.
    (db.abAgentSession.findFirst as any).mockResolvedValueOnce(OTHER_PENDING_SESSION);

    const ctx = makeCtx({
      checkActiveTaxReview: vi.fn().mockResolvedValue({ active: true, taxYear: 2025 }),
      answerTaxReview: vi.fn().mockResolvedValue({ message: '✅ Filed your 2025 return.' }),
    });

    const result = await handleAgentMessage(
      { text: 'yes', tenantId: 't1', channel: 'telegram', sessionAction: 'confirm' } as any,
      ctx as any,
    );

    expect(ctx.answerTaxReview).toHaveBeenCalledWith('t1', 2025, 'yes');
    // The other skill's gated destructive action must NOT have run — that
    // approval was never given.
    expect(ctx.executeClassification).not.toHaveBeenCalled();
    expect(result.data.skillUsed).toBe('tax-review-agent');
    expect(result.data.message).toContain('2025 return');
  });

  it('the interception is checked before session recovery even bothers to load a session', async () => {
    const { db } = await import('../db/client.js');
    const ctx = makeCtx({
      checkActiveTaxReview: vi.fn().mockResolvedValue({ active: true, taxYear: 2025 }),
      answerTaxReview: vi.fn().mockResolvedValue({ message: 'Updated.' }),
    });

    await handleAgentMessage({ text: 'yes', tenantId: 't1', channel: 'web' } as any, ctx as any);

    // Ordering, asserted structurally: an active review short-circuits before
    // Step 1's getActiveSession() query runs at all.
    expect(ctx.checkActiveTaxReview).toHaveBeenCalled();
    expect(db.abAgentSession.findFirst).not.toHaveBeenCalled();
  });

  it('a session action for a tenant with NO active review is handled by Step 1 exactly as before', async () => {
    const { db } = await import('../db/client.js');
    (db.abAgentSession.findFirst as any).mockResolvedValueOnce(OTHER_PENDING_SESSION);

    const ctx = makeCtx(); // checkActiveTaxReview -> { active: false }
    ctx.executeClassification.mockResolvedValue({
      skillUsed: 'delete-invoices',
      confidence: 1,
      responseData: { message: 'Deleted 3 draft invoices.', skillUsed: 'delete-invoices', confidence: 1 },
    });

    const result = await handleAgentMessage(
      { text: 'yes', tenantId: 't1', channel: 'telegram', sessionAction: 'confirm' } as any,
      ctx as any,
    );

    expect(ctx.executeClassification).toHaveBeenCalled();
    expect(ctx.answerTaxReview).not.toHaveBeenCalled();
    expect(result.data.message).toContain('Deleted 3 draft invoices');
  });

  it('when no review is active, classification runs exactly as before (no behavior change for every other message)', async () => {
    const ctx = makeCtx();
    ctx.classifyAndExecuteV1.mockResolvedValue({
      selectedSkill: { name: 'query-expenses' }, extractedParams: {}, confidence: 0.9,
      responseData: { message: 'Here are your expenses.', actions: [], chartData: null, skillUsed: 'query-expenses', confidence: 0.9, latencyMs: 10 },
    });

    const result = await handleAgentMessage({ text: 'show my expenses', tenantId: 't1', channel: 'web' } as any, ctx as any);

    expect(ctx.checkActiveTaxReview).toHaveBeenCalledWith('t1');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalled();
    expect(result.data.message).toContain('expenses');
  });
});
