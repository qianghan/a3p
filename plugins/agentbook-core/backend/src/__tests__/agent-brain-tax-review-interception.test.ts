import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgentMessage } from '../agent-brain.js';

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
