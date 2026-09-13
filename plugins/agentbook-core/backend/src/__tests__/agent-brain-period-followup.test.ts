import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestContext } from './helpers/test-context';

/**
 * WIRING GUARD — canonical eval thread t-alex-period-followup.
 *
 *     "how much did I spend on travel last month?"  -> query-expenses, June
 *     "and meals?"                                  -> query-expenses, YEAR TO DATE
 *
 * Both turns routed to the right skill, so the eval passed. But the second
 * answer covered a different window from the first, and neither reply said
 * which — so the user was handed two numbers to compare that were not
 * comparable.
 *
 * carryForwardPeriod has its own unit tests. This file exists because a unit
 * test on a helper cannot tell you the PIPELINE still calls it: delete the call
 * in agent-brain.ts and every period-parse test stays green while the product
 * regresses. So this asserts on the text that actually reaches the classifier,
 * which is the same text parameter extraction and the advisor prompt see.
 */

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
    abAccount: { findFirst: vi.fn(async () => null) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

const QUERY_EXPENSES = {
  name: 'query-expenses',
  endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
  confirmBefore: false,
};

/** The prior exchange, as the thread stores it: chronological, user then bot. */
function withPriorTurn(question: string) {
  threadState.turns = [
    { role: 'user', text: question, at: new Date().toISOString() },
    { role: 'bot', text: 'You spent $1,240.00 across 9 transactions.', at: new Date().toISOString(), intent: 'query-expenses' },
  ];
}

function ask(text: string) {
  return buildTestContext({
    text,
    tenantId: 'tenant-alex',
    channel: 'web',
    classification: { selectedSkill: QUERY_EXPENSES, extractedParams: { question: text } },
    skills: [QUERY_EXPENSES],
    skillResponses: {
      'POST /api/v1/agentbook-expense/advisor/ask': { success: true, data: { answer: 'ok' } },
    },
  });
}

/** The text the classifier was handed — post referent + period resolution. */
async function classifiedText(text: string) {
  const { req, ctx, classifyOnly } = ask(text);
  const { handleAgentMessage } = await import('../agent-brain');
  await handleAgentMessage(req as any, ctx as any);
  expect(classifyOnly).toHaveBeenCalled();
  return (classifyOnly as any).mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  threadState.turns = [];
});

describe('a follow-up inherits the period of the question it follows', () => {
  it('"and meals?" after "...last month?" is resolved with the period attached', async () => {
    withPriorTurn('how much did I spend on travel last month?');
    expect(await classifiedText('and meals?')).toBe('and meals last month?');
  });

  it('"what about software?" after "...in June?" inherits June', async () => {
    withPriorTurn('what did I spend on travel in June?');
    expect(await classifiedText('what about software?')).toBe('what about software in June?');
  });

  it('a follow-up that names its own period is left alone', async () => {
    withPriorTurn('how much did I spend on travel last month?');
    expect(await classifiedText('and meals in May?')).toBe('and meals in May?');
  });

  it('a full question is left alone', async () => {
    withPriorTurn('how much did I spend on travel last month?');
    const text = 'how much did I spend on meals?';
    expect(await classifiedText(text)).toBe(text);
  });

  it('a first message with no thread history is untouched', async () => {
    expect(await classifiedText('and meals?')).toBe('and meals?');
  });

  it('does not fire when the prior turn had no period', async () => {
    withPriorTurn('show me my expenses');
    expect(await classifiedText('and meals?')).toBe('and meals?');
  });
});

/**
 * Same defect one layer over: the follow-up has no TOPIC rather than no period.
 *
 *     "What is my cash balance?" -> query-finance, answered
 *     "Give me more details"     -> query-finance, "More details about what?"
 *
 * The LLM classifier sees the thread and routes correctly; the skill's own
 * HTTP route builds its answer from `question` alone and never sees it. So the
 * topic has to travel in the text, exactly as the period does above.
 */
describe('a bare elaboration request inherits the previous question topic', () => {
  it('"Give me more details" after a cash-balance question carries the topic', async () => {
    withPriorTurn('What is my cash balance?');
    const text = await classifiedText('Give me more details');
    expect(text).toContain('regarding: "What is my cash balance?"');
    expect(text).toContain('Give me more details');
  });

  it('a question with its own topic is left alone', async () => {
    withPriorTurn('What is my cash balance?');
    const text = 'What is my revenue this quarter?';
    expect(await classifiedText(text)).toBe(text);
  });

  it('WIRING: Step 2.5 in agent-brain.ts calls carryForwardTopic', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');
    const step = src.slice(src.indexOf('── Step 2.5'), src.indexOf('── Step 2.6'));
    expect(step).toContain('carryForwardTopic(');
  });
});
