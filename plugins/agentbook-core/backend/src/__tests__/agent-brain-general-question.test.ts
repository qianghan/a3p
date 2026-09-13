import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestContext } from './helpers/test-context';
import type { LLMFixture } from './helpers/mock-llm';
import { repairBrief } from '../consultation-review';

/**
 * One line out of each of the two prompts in `brainAccountantFallback`, so a
 * test can say WHICH job the advisor was asked to do. Asserting on the mode
 * argument would pin the call shape; asserting on the prompt pins what the
 * model was actually told.
 */
const CONSULTATION_MARKER = 'asking you to explain something about tax';
const UNCLEAR_MARKER = 'could not confidently understand';

/**
 * The first line of the repair brief, taken from the reviewer itself rather
 * than retyped — so a test can assert that NO repair round-trip happened
 * without pinning wording that lives in another file.
 */
const REPAIR_MARKER = repairBrief([]).split('\n')[0];

/** The exact string production answered "hello" with. */
const SAFE_FALLBACK_FRAGMENT = /can't stand behind/i;

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

function setup(
  overrides: { text?: string; confidence?: number; fixtures?: LLMFixture[] } = {},
) {
  const text = overrides.text ?? 'Give me more details';
  const built = buildTestContext({
    text,
    tenantId: 'tenant-gq',
    classification: {
      selectedSkill: GENERAL_QUESTION,
      extractedParams: { question: text },
      // Comfortably above the small-talk floor: this is a real follow-up
      // question, so it must keep the consultation framing.
      confidence: overrides.confidence ?? 0.5,
    },
    skills: [GENERAL_QUESTION],
    llmFixtures: [
      // Caller fixtures first: `buildMockGemini` takes the first match, so a
      // test can pin the advisor's reply without restating the defaults.
      ...(overrides.fixtures ?? []),
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

  it('frames a real question as a consultation', async () => {
    const { req, ctx, llmCalls } = setup();
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(
      llmCalls.history.some((h) => h.system.includes(CONSULTATION_MARKER)),
      'the advisory prompt was never used',
    ).toBe(true);
  });

  it('does not put small talk through the consultation prompt', async () => {
    // `general-question` is the classifier's catch-all — it is also the
    // ultimate fallback at confidence ≈ 0.3. Hard-coding 'consultation' sent
    // "hello" to a prompt that instructs the model to explain a tax rule, and
    // then through the consultation reviewer, whose "a reply that is only a
    // question is the clarify-loop failure" rule REPAIRS a greeting into
    // "I can look this up against your books, but…" — three LLM calls to
    // make "hello" worse.
    const { req, ctx, llmCalls } = setup({ text: 'hello', confidence: 0.3 });
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.success).toBe(true);
    expect(
      llmCalls.history.some((h) => h.system.includes(UNCLEAR_MARKER)),
      'small talk did not get the didn\'t-understand prompt',
    ).toBe(true);
    expect(
      llmCalls.history.some((h) => h.system.includes(CONSULTATION_MARKER)),
      'small talk was framed as a tax consultation',
    ).toBe(false);
  });

  it('keeps the thread and the ledger facts in the unclear mode too', async () => {
    // F6: the bug this file was opened for was an answerer that got no
    // conversation. Choosing the mode must not quietly re-introduce it on the
    // branch that now takes the other one.
    const { req, ctx, llmCalls } = setup({ text: 'hello', confidence: 0.3 });
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(
      llmCalls.history.some((h) => h.user.includes('61 bank transactions')),
      'previous turn missing from the unclear prompt',
    ).toBe(true);
    expect(
      llmCalls.history.some((h) => (h.user + h.system).includes('16,926.10')),
      'grounding facts missing from the unclear prompt',
    ).toBe(true);
  });

  it('awaits the conversation row it writes', () => {
    // Fire-and-forget immediately before a `return`: a serverless runtime can
    // freeze the function the moment the response is sent, and the answer the
    // next turn refers back to is never persisted.
    const SRC = readFileSync(join(__dirname, '../agent-brain.ts'), 'utf8');
    const start = SRC.indexOf("classification?.selectedSkill?.name === 'general-question'");
    expect(start, 'the Step 3a′ block must exist').toBeGreaterThan(0);
    const block = SRC.slice(start, SRC.indexOf('Fallback for legacy callers', start));
    const creates = block.match(/(await\s+)?db\.abConversation\.create\(/g) ?? [];
    expect(creates.length, 'the block writes a conversation row').toBeGreaterThan(0);
    for (const c of creates) expect(c).toContain('await');
  });

  it('answers a greeting with the greeting, not the safe fallback', async () => {
    // The prod regression (2026-09-13): "hello" came back as "I can look this
    // up against your books, but I don't want to quote you a number I can't
    // stand behind…". Choosing the 'unclear' PROMPT was not enough — the
    // reviewer still ran with the consultative default, and its "a reply that
    // is only a question is the clarify-loop failure" rule repaired the
    // model's perfectly good greeting into safeFallback().
    const GREETING = 'Hello! How can I help you with your accounting today?';
    const { req, ctx, llmCalls } = setup({
      text: 'hello',
      confidence: 0.3,
      fixtures: [{ userMatch: 'hello', response: GREETING }],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.success).toBe(true);
    // The model's own greeting, verbatim. (First contact on a human channel
    // also prepends the one-time persona introduction ahead of a bare
    // greeting — composeFirstContact — so the advisor's reply is the tail.)
    expect(res.data.message.endsWith(GREETING), res.data.message).toBe(true);
    expect(res.data.message).not.toMatch(SAFE_FALLBACK_FRAGMENT);

    // Exactly one call reached the advisor, and none of them was a repair —
    // the draft passed review first time. (The persona voice makes its own
    // call, so count the advisor's prompt specifically.)
    const advisorCalls = llmCalls.history.filter((h) => h.system.includes(UNCLEAR_MARKER));
    expect(advisorCalls, 'the advisor was asked more than once').toHaveLength(1);
    expect(
      llmCalls.history.some((h) => h.system.includes(REPAIR_MARKER)),
      'a repair round-trip ran on a valid greeting',
    ).toBe(false);
  });

  it('returns a follow-up answer that ends in a question verbatim', async () => {
    // "Give me more details" is under-specified by design. An answer plus one
    // narrowing question is the right reply to it, and must not be repaired
    // away either — same bucket, the consultative mode of it.
    const ANSWER =
      'Those 61 unmatched transactions are bank lines with nothing attached yet. '
      + 'Want me to start with the largest ones?';
    const { req, ctx, llmCalls } = setup({
      fixtures: [{ userMatch: 'more details', response: ANSWER }],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    // Verbatim, and leading — the one-time persona introduction trails an
    // answer rather than replacing it.
    expect(res.data.message.startsWith(ANSWER), res.data.message).toBe(true);
    expect(res.data.message).not.toMatch(SAFE_FALLBACK_FRAGMENT);
    expect(
      llmCalls.history.some((h) => h.system.includes(REPAIR_MARKER)),
      'a repair round-trip ran on a valid follow-up answer',
    ).toBe(false);
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
