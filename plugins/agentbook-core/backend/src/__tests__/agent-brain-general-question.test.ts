import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * `general-question` is a conversation, not an HTTP call.
 *
 * Its manifest pointed at `POST /api/v1/agentbook-core/ask` — an Express route
 * that only `tsx src/server.ts` ever mounts. Production serves the Next route
 * handlers, which never carried a port of it, so in prod EVERY general
 * question failed with NOT_IMPLEMENTED and was answered by the engagement
 * fallback, which sees no conversation:
 *
 *   user: Briefing
 *   bot:  Good morning. 61 bank transactions need matching…
 *   user: Give me more details
 *   bot:  More details about what?
 *
 * The answerer that was already right for this is the grounded advisor the
 * consultative triage uses: it gets the thread, the tenant's ledger facts and
 * the published rates, and its draft is reviewed before the user sees it.
 * This test pins BOTH halves — the advisor answers (no skill execution), and
 * the thread plus the grounding facts reach a prompt.
 */

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
        activeEntities: [],
        parkedFills: [],
        turns: [
          { role: 'user', text: 'Briefing', at: '2026-09-13T15:06:00.000Z' },
          {
            role: 'bot',
            text: 'Good morning. 61 bank transactions need matching; two expenses over $25 are missing receipts.',
            at: '2026-09-13T15:06:33.000Z',
            intent: 'daily-briefing',
          },
        ],
      })),
      create: vi.fn(async (args: any) => ({ id: 'thread-1', turns: [], ...args.data })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ ...args.data, id: 'sess-new', version: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => ({ locale: 'en-US', jurisdiction: 'ca' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    abAdvisorPersona: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ ...args.data })),
      update: vi.fn(async () => ({})),
    },
    $executeRaw: vi.fn(async () => 1),
  },
}));

const GENERAL_QUESTION = {
  name: 'general-question',
  endpoint: { method: 'INTERNAL', url: '' },
  parameters: { question: 'string' },
};

function setup() {
  const built = buildTestContext({
    text: 'Give me more details',
    tenantId: 'tenant-gq',
    classification: {
      selectedSkill: GENERAL_QUESTION,
      extractedParams: { question: 'Give me more details' },
      confidence: 0.4,
    },
    skills: [GENERAL_QUESTION],
    llmFixtures: [
      {
        userMatch: 'more details',
        response: 'Those 61 unmatched transactions are bank lines with no expense or invoice attached yet.',
      },
      // A generous final fallback: the advisor also asks for a persona voice,
      // and a null there would only degrade the identity line — but leaving it
      // unmatched would make a future prompt change look like a test failure.
      { response: 'ok' },
    ],
    skillResponses: { 'POST /api/v1/agentbook-core/ask': { data: { answer: 'from the dead endpoint' } } },
  });
  built.ctx.buildGroundingFacts = vi.fn(async () => ['Cash on hand: $16,926.10']);
  return built;
}

describe('general-question is answered with the thread in view', () => {
  it('sends the previous bot turn to the model and never executes a skill', async () => {
    const { req, ctx, executeClassification, llmCalls } = setup();

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.success).toBe(true);
    expect(res.data.message).toContain('61 unmatched');
    // The whole point: no HTTP skill call. `/ask` does not exist in prod, and
    // executing it is what produced "More details about what?".
    expect(executeClassification).not.toHaveBeenCalled();

    const sawHistory = llmCalls.history.some(
      (h) => h.user.includes('61 bank transactions') || h.system.includes('61 bank transactions'),
    );
    expect(sawHistory, 'previous bot turn was not in any prompt').toBe(true);

    const sawFacts = llmCalls.history.some((h) => (h.user + h.system).includes('16,926.10'));
    expect(sawFacts, 'grounding facts were not in any prompt').toBe(true);
  });

  it('attributes the answer to general-question and records the turn', async () => {
    const { req, ctx } = setup();
    const { db } = await import('../db/client.js');

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.data.skillUsed).toBe('general-question');
    // The answer has to land in both places the next turn reads: the thread
    // (so a follow-up can refer to it) and AbConversation (so the answer is
    // in the chat-quality record at all).
    expect((db.abConvThread.update as any)).toHaveBeenCalled();
    const convoWrite = (db.abConversation.create as any).mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.skillUsed === 'general-question');
    expect(convoWrite, 'no AbConversation row for the answer').toBeTruthy();
    expect(convoWrite.question).toBe('Give me more details');
    expect(convoWrite.answer).toContain('61 unmatched');
  });

  it('survives a grounding lookup that throws, rather than failing the turn', async () => {
    const { req, ctx, executeClassification } = setup();
    ctx.buildGroundingFacts = vi.fn(async () => {
      throw new Error('ledger unavailable');
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.success).toBe(true);
    expect(res.data.message).toContain('61 unmatched');
    expect(executeClassification).not.toHaveBeenCalled();
  });
});
