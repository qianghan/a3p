import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "hello" is not a skill.
 *
 * Production, minutes apart on the same account: "hello" was answered once
 * with "Hello! How can I help?" and once with a full morning briefing —
 * revenue, receivables, tax deadlines, the lot. Nothing about the message
 * changed. No skill claims "hello" by regex, so it fell through to the LLM
 * classifier, which is free to pick any of ~85 skills and picked
 * daily-briefing that time.
 *
 * Classifier variance on the single most common opening message is not a
 * tolerable behaviour, and the failure is unbounded: the next roll could pick
 * a skill that writes. So greetings and thanks are matched before any skill
 * trigger and pinned to the catch-all at low confidence, which agent-brain
 * answers conversationally (Step 3a', 'unclear' mode) without executing
 * anything.
 */

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abTenantConfig: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abExpense: { findMany: vi.fn(async () => []) },
    abAccount: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

// Stage 3 (the LLM classifier) is stubbed to answer "daily-briefing" — what
// it actually returned in production for "hello". The catch-all fallback also
// yields general-question at 0.3, so without this the test would pass on the
// broken code; with it, a greeting reaching Stage 3 comes back as
// daily-briefing and the assertion fails for the production reason.
const geminiFetch = vi.fn(async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{
    text: JSON.stringify({ skill: 'daily-briefing', parameters: {}, confidence: 0.9 }),
  }] } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  vi.stubGlobal('fetch', geminiFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

const GENERAL_QUESTION = {
  name: 'general-question',
  description: 'Answer any general financial or accounting question',
  category: 'finance',
  triggerPatterns: [],
  parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
  endpoint: { method: 'INTERNAL', url: '' },
};

const DAILY_BRIEFING = {
  name: 'daily-briefing',
  description: 'Morning briefing with revenue, receivables and deadlines',
  category: 'finance',
  triggerPatterns: ['daily briefing', 'morning briefing'],
  parameters: {},
  endpoint: { method: 'INTERNAL', url: '' },
};

const RECORD_EXPENSE = {
  name: 'record-expense',
  description: 'Record a business expense',
  category: 'expenses',
  triggerPatterns: ['record|log|spent|paid'],
  parameters: {
    amountCents: { type: 'number', required: true, extractHint: 'the amount' },
    vendor: { type: 'string', required: false, extractHint: 'the merchant' },
  },
  endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/expenses' },
};

const SKILLS = [RECORD_EXPENSE, DAILY_BRIEFING, GENERAL_QUESTION];

async function classify(text: string) {
  const { classifyOnly } = await import('../server');
  return classifyOnly(text, 'tenant-maya', 'web', [], [], SKILLS as any, [], {});
}

describe('greetings and thanks route to the catch-all, deterministically', () => {
  it.each([
    ['hello'], ['Hello!'], ['hi'], ['Hey there'.slice(0, 3)], ['yo'],
    ['good morning'], ['Good Morning!'],
    ['thanks'], ['thank you'], ['thx'], ['cheers'], ['Thanks!!'],
    ['bye'], ['goodbye'],
    ['bonjour'], ['salut'], ['merci'], ['au revoir'],
    ['你好'], ['您好'], ['谢谢'], ['再见'], ['嗨'],
    ['hello 👋'], ['hello.'], ['  hi  '],
  ])('%j is answered, not executed', async (text) => {
    const res: any = await classify(text);
    expect(res?.selectedSkill?.name).toBe('general-question');
    expect(res?.confidence).toBe(0.3);
    expect(res?.extractedParams?.question).toBe(text);
    // Deterministic means the classifier is never consulted at all.
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  it('a greeting that carries an instruction is NOT shortcut', async () => {
    // The shortcut must only claim messages that are nothing but a greeting.
    // "hello, record $40 lunch" is a recorded expense with a polite opening.
    const res: any = await classify('hello, record $40 lunch');
    expect(res?.selectedSkill?.name).toBe('record-expense');
    expect(res?.extractedParams?.amountCents).toBe(4000);
  });

  it.each([
    ['hi, how much did I spend on travel?'],
    ['thanks for the invoice, can you resend it'],
    ['good morning, what do I owe in tax'],
  ])('%j still reaches normal routing', async (text) => {
    const res: any = await classify(text);
    expect(res?.selectedSkill?.name).not.toBe('general-question');
  });
});

describe('the greeting matcher is linear on input it rejects', () => {
  it('a long non-greeting is rejected in microseconds', async () => {
    // A SUCCEEDING match proves nothing — it stops at the first path that
    // works. The failing match is the one that has to exhaust the pattern.
    const { GREETING_ONLY_RE } = await import('../server');
    const evil = 'hi '.repeat(2) + 'z'.repeat(50_000);
    const t0 = performance.now();
    expect(GREETING_ONLY_RE.test(evil)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('is anchored at both ends', async () => {
    const { GREETING_ONLY_RE } = await import('../server');
    expect(GREETING_ONLY_RE.test('hi there, log $5')).toBe(false);
    expect(GREETING_ONLY_RE.test('say hello')).toBe(false);
  });
});
