import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';
import type { LLMFixture } from './helpers/mock-llm';

/**
 * `query-finance` beyond the cash shortcut had no working answerer.
 *
 * Its manifest pointed at `POST /api/v1/agentbook-core/ask` — the same Express
 * route production never mounts that `general-question` was moved off. Exactly
 * ONE query-finance case works in prod: the inline cash-balance shortcut in
 * `_executeClassificationCore`. Every other finance question ("how is my
 * revenue trending", and — the reported transcript — a follow-up carrying the
 * cash topic) fell through the dead route into the failure branch, which asked
 * the engagement model to clarify:
 *
 *   user: What is my cash balance?
 *   bot:  You have CA$233,786.10 on hand. • AR: CA$216,860.00 • Cash: CA$16,926.10
 *   user: Give me more details
 *   bot:  More details about what?
 *
 * The grounded advisor already answers this class of question: it gets the
 * thread, the tenant's ledger snapshot (cash, AR, revenue, expenses) and a
 * review pass. So query-finance splits in two — the cash shortcut keeps its
 * inline ledger answer, everything else goes to the advisor.
 *
 * The guard tests the ORIGINAL text, not the resolved one, because that is the
 * string `executeClassification` is handed (agent-brain Step 3c) and therefore
 * the string the server-side shortcut itself tests. Testing `resolvedText`
 * here would send "Give me more details — regarding: \"What is my cash
 * balance?\"" to the executor on the strength of a substring the executor
 * never sees — straight back down the dead route.
 */

const CASH_ANSWER =
  'You have CA$233,786.10 on hand. • Accounts Receivable: CA$216,860.00 • Cash: CA$16,926.10';

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => ({
        id: 'thread-qf',
        lastActiveAt: new Date(),
        activeEntities: [],
        parkedFills: [],
        turns: [
          { role: 'user', text: 'What is my cash balance?', at: '2026-09-13T15:20:00.000Z' },
          { role: 'bot', text: CASH_ANSWER, at: '2026-09-13T15:20:04.000Z', intent: 'query-finance' },
        ],
      })),
      create: vi.fn(async (args: any) => ({ id: 'thread-qf', turns: [], ...args.data })),
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

const QUERY_FINANCE = {
  name: 'query-finance',
  endpoint: { method: 'INTERNAL', url: '' },
  parameters: { question: 'string' },
};

const DRAFT =
  'Of that CA$233,786.10, CA$16,926.10 is cash in the bank and CA$216,860.00 is money clients still owe you.';

function setup(overrides: { text?: string; fixtures?: LLMFixture[] } = {}) {
  const text = overrides.text ?? 'Give me more details';
  const built = buildTestContext({
    text,
    tenantId: 'tenant-qf',
    classification: {
      selectedSkill: QUERY_FINANCE,
      // The classifier runs on the RESOLVED text, so this is what its
      // extraction produces — the topic-carrying string.
      extractedParams: { question: text },
      confidence: 0.8,
    },
    skills: [QUERY_FINANCE],
    llmFixtures: [
      ...(overrides.fixtures ?? []),
      { userMatch: 'more details', response: DRAFT },
      { response: 'ok' },
    ],
    // The dead route, wired so that reaching it would SUCCEED. A test that
    // only mocked a failure here would pass on the broken code too.
    skillResponses: { 'POST /api/v1/agentbook-core/ask': { data: { answer: 'from the dead endpoint' } } },
  });
  built.ctx.buildGroundingFacts = vi.fn(async () => [
    'Cash on hand: CA$16,926.10',
    'Accounts receivable: CA$216,860.00',
  ]);
  return built;
}

describe('query-finance beyond the cash shortcut goes to the grounded advisor', () => {
  it('answers a topic-carrying follow-up without executing the dead route', async () => {
    const { req, ctx, executeClassification, llmCalls } = setup();

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.success).toBe(true);
    expect(executeClassification).not.toHaveBeenCalled();
    expect(res.data.message).not.toContain('from the dead endpoint');

    const sawHistory = llmCalls.history.some(
      (h) => (h.user + h.system).includes('CA$233,786.10'),
    );
    expect(sawHistory, 'the previous bot turn was not in any prompt').toBe(true);

    const sawFacts = llmCalls.history.some(
      (h) => (h.user + h.system).includes('Accounts receivable: CA$216,860.00'),
    );
    expect(sawFacts, 'the grounding facts were not in any prompt').toBe(true);
  });

  it('sends the advisor the RESOLVED question, carrying the topic', async () => {
    const { req, ctx, llmCalls } = setup();
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    // Without this the advisor is asked "Give me more details" and can only
    // ask back — the exact failure, relocated rather than fixed.
    const sawTopic = llmCalls.history.some(
      (h) => (h.user + h.system).includes('regarding: "What is my cash balance?"'),
    );
    expect(sawTopic, 'the carried topic never reached the advisor').toBe(true);
  });

  it('still attributes the turn to query-finance', async () => {
    const { req, ctx } = setup();
    const { db } = await import('../db/client.js');
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.data.skillUsed).toBe('query-finance');
    const convoWrite = (db.abConversation.create as any).mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.skillUsed === 'query-finance');
    expect(convoWrite, 'no AbConversation row attributed to query-finance').toBeTruthy();
    expect(convoWrite.question).toBe('Give me more details');
  });

  it('leaves the cash-balance shortcut alone', async () => {
    // The one query-finance case that DOES work in prod. Routing it to the
    // advisor would trade a real ledger total for a generated one.
    const { req, ctx, executeClassification } = setup({ text: 'What is my cash balance?' });
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalled();
  });
});
