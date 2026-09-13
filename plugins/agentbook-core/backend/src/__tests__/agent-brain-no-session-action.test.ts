import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * A bare "yes" / "cancel" / "undo" when NOTHING is pending.
 *
 * The Telegram adapter maps those words to `req.sessionAction`, and the brain
 * honoured the flag only while an AbAgentSession was alive. With no session
 * the word fell through to the classifier as if it were a fresh request, and
 * the low-confidence fallback improvised — "Are you trying to cancel a
 * subscription, an invoice, or something else?" — for a user who had asked
 * nothing of the sort.
 *
 * Two cases have to stay separate:
 *   - the bot's own last turn ended in a question → "yes" ANSWERS it, and the
 *     conversation must continue through normal classification;
 *   - nothing is open at all → one plain line saying so, no classification.
 *
 * The resolution keys on resolveSessionAction(flag, text), not on the flag
 * alone: only Telegram sets the flag, so a typed "cancel" on web / MCP /
 * WhatsApp has to behave identically.
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
        id: 't',
        lastActiveAt: new Date(),
        activeEntities: [],
        parkedFills: [],
        turns: threadState.turns,
      })),
      create: vi.fn(async (a: any) => ({ id: 't', turns: [], ...a.data })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ ...a.data, id: 's', version: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => ({ locale: 'en-US' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    abAdvisorPersona: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

import { db } from '../db/client.js';
import { handleAgentMessage, mapInternalRunResult } from '../agent-brain';

beforeEach(() => {
  threadState.turns = [];
  vi.clearAllMocks();
});

describe('session actions with no active session', () => {
  it('a typed "cancel" (no adapter flag — web/MCP) with nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"cancel" with the Telegram flag and nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel', sessionAction: 'cancel' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"yes" with nothing pending and no open question says so', async () => {
    threadState.turns = [
      { role: 'bot', text: 'Recorded: $25.00 — Uber [Travel]', at: new Date().toISOString() },
    ];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'yes', sessionAction: 'confirm' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"yes" that answers the bot\'s own question continues the conversation', async () => {
    threadState.turns = [
      { role: 'bot', text: 'Is this a contractor or an employee?', at: new Date().toISOString() },
    ];
    const gq = {
      name: 'general-question',
      endpoint: { method: 'INTERNAL', url: '' },
      parameters: { question: 'string' },
    };
    const { req, ctx, classifyOnly } = buildTestContext({
      text: 'yes',
      sessionAction: 'confirm',
      classification: { selectedSkill: gq, extractedParams: { question: 'yes' }, confidence: 0.5 },
      skills: [gq],
      llmFixtures: [{ response: 'Got it — as an employee at $5K/mo…' }],
    });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(classifyOnly).toHaveBeenCalled();
    expect(res.data.skillUsed).not.toBe('session');
  });
});


/**
 * C2 — the trailing-"?" heuristic vs the 300-char truncation.
 *
 * updateThreadTurns stores the bot's text as `agentText.slice(0, 300)`. A
 * clarifying question at the END of a long reply is exactly the case that
 * gets cut, so the stored turn no longer ends in "?" and the user's "yes"
 * was answered with "Nothing is waiting for a yes" — the bug this whole
 * step exists to prevent. The turn therefore records `askedQuestion`,
 * computed on the FULL text before truncation.
 */
describe('a clarifying question survives the 300-char turn truncation', () => {
  it('continues on "yes" when the stored text was truncated but askedQuestion is set', async () => {
    const long = 'Here is the breakdown. '.repeat(20); // > 300 chars
    const stored = (long + 'Should I categorize the rest?').slice(0, 300);
    expect(stored.trim().endsWith('?')).toBe(false); // the truncation really bites
    threadState.turns = [
      { role: 'bot', text: stored, at: new Date().toISOString(), askedQuestion: true },
    ];
    const gq = {
      name: 'general-question',
      endpoint: { method: 'INTERNAL', url: '' },
      parameters: { question: 'string' },
    };
    const { req, ctx, classifyOnly } = buildTestContext({
      text: 'yes',
      sessionAction: 'confirm',
      classification: { selectedSkill: gq, extractedParams: { question: 'yes' }, confidence: 0.5 },
      skills: [gq],
      llmFixtures: [{ response: 'Done.' }],
    });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(classifyOnly).toHaveBeenCalled();
    expect(res.data.skillUsed).not.toBe('session');
  });

  it('records askedQuestion on every bot turn it writes', async () => {
    threadState.turns = [];
    const { req, ctx } = buildTestContext({ text: 'cancel' });
    await handleAgentMessage(req as any, ctx as any);
    const call = (db.abConvThread.update as any).mock.calls.at(-1);
    const turns = call?.[0]?.data?.turns as any[];
    const bot = [...turns].reverse().find((t) => t.role === 'bot');
    expect(bot).toBeDefined();
    // "Nothing is waiting to be cancelled." is not a question.
    expect(bot.askedQuestion).toBe(false);
  });
});

/**
 * I3 — "cancel" is never an answer.
 *
 * Replies routinely end with a suggestion ("Want me to categorize the rest?"),
 * so treating ANY session word as "an answer to the open question" let a bare
 * "cancel" fall back into classification — and the improvised
 * "Are you trying to cancel a subscription, an invoice…?" reply came straight
 * back. Only an affirmative, or an explicit no/non/nope, answers a question.
 */
describe('an open question does not turn "cancel" into a guess', () => {
  const openQuestion = () => [
    { role: 'bot', text: 'Want me to categorize the rest?', at: new Date().toISOString(), askedQuestion: true },
  ];

  it('"cancel" after a question still says nothing is pending', async () => {
    threadState.turns = openQuestion();
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel', sessionAction: 'cancel' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"no" after a question is an answer and continues the conversation', async () => {
    threadState.turns = openQuestion();
    const gq = {
      name: 'general-question',
      endpoint: { method: 'INTERNAL', url: '' },
      parameters: { question: 'string' },
    };
    const { req, ctx, classifyOnly } = buildTestContext({
      // Telegram maps a bare "no" to sessionAction 'cancel'; the raw text is
      // what tells the two apart.
      text: 'no',
      sessionAction: 'cancel',
      classification: { selectedSkill: gq, extractedParams: { question: 'no' }, confidence: 0.5 },
      skills: [gq],
      llmFixtures: [{ response: 'No problem — left them as they are.' }],
    });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(classifyOnly).toHaveBeenCalled();
    expect(res.data.skillUsed).not.toBe('session');
  });
});

/**
 * C1 — a failed INTERNAL plan step must be a failed step.
 *
 * `_executeClassificationCore`'s failure returns are shaped
 * `{ skillResponse: null, confidence: 0, responseData: { message: "I couldn't …",
 * confidence: 0 } }` — they carry a responseData like every other return, so
 * `success: Boolean(r.responseData || r.skillResponse?.success)` was true for
 * ALL of them. The step went to 'done', the evaluator never saw a failure, and
 * a dependent step read `data: undefined`.
 */
describe('mapInternalRunResult', () => {
  it('treats a core failure return (null skillResponse + confidence 0) as a failure', () => {
    const r = mapInternalRunResult({
      selectedSkill: { name: 'categorize-expenses' },
      confidence: 0,
      skillUsed: 'categorize-expenses',
      skillResponse: null,
      responseData: { message: "I couldn't categorize those expenses.", confidence: 0 },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("I couldn't");
    expect(r.message).toBeUndefined();
  });

  it('treats a success return with no `success` field on skillResponse as a success', () => {
    const r = mapInternalRunResult({
      skillResponse: { data: { total: 3 } },
      responseData: { message: 'Categorized 3 of 3', confidence: 0.9 },
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ total: 3 });
    expect(r.message).toBe('Categorized 3 of 3');
    expect(r.error).toBeUndefined();
  });

  it('honours an explicit status/success failure flag', () => {
    expect(mapInternalRunResult({ status: 'error', responseData: { message: 'boom' } }).success).toBe(false);
    expect(mapInternalRunResult({ success: false, skillResponse: { data: {} }, responseData: { message: 'boom' } }).success).toBe(false);
  });

  it('fails on a missing result rather than reporting success', () => {
    expect(mapInternalRunResult(null).success).toBe(false);
    expect(mapInternalRunResult(undefined).error).toBeTruthy();
  });
});
