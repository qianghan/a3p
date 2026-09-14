import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "Expenses" is a question, not a plan.
 *
 * Nightly run 34793265788, phase6b: the literal one-word message "Expenses"
 * — turn 2 of the owner's own production transcript — was answered with
 * "Here's my plan: ..." and a Proceed?/Cancel preview. No skill trigger
 * claims the bare noun (query-expenses' patterns all want a verb), so it fell
 * through to the Stage-3 LLM classifier, which scored it under the 0.55
 * confidence-escalation threshold; agent-brain Step 3b then gated a read-only
 * question behind a confirmation. The retry classified the identical word as
 * query-expenses and passed, and the leftover session swallowed the next
 * "cancel" ("Plan cancelled." instead of "Nothing to cancel").
 *
 * A one-word topic must not depend on classifier variance. Mirrors
 * greeting-routing.test.ts, which pins the same class of message from the
 * other direction.
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

// Stage 3 is stubbed to answer "daily-briefing": a skill nothing here should
// ever route to. Any bare topic word that reaches the LLM classifier comes
// back as daily-briefing and fails its assertion for the production reason,
// so these tests cannot pass on the un-shortcut code.
const geminiFetch = vi.fn(async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{
    text: JSON.stringify({ skill: 'daily-briefing', parameters: {}, confidence: 0.4 }),
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

// Manifest shapes copied from built-in-skills.ts (trigger patterns trimmed to
// the ones that matter here) so routing is exercised against the real rules.
const QUERY_EXPENSES = {
  name: 'query-expenses',
  description: 'Query, search, list, or ask questions about expenses',
  triggerPatterns: ['show.*expense', 'list.*expense', 'how much.*spen', 'my.*spend'],
  parameters: { question: { type: 'string', required: true } },
  endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
};
const QUERY_FINANCE = {
  name: 'query-finance',
  description: 'Ask about cash balance, revenue, profit, tax, clients',
  triggerPatterns: ['balance', 'revenue', 'profit', 'tax', 'income'],
  parameters: { question: { type: 'string', required: true } },
  endpoint: { method: 'INTERNAL', url: '' },
};
const QUERY_INVOICES = {
  name: 'query-invoices',
  description: 'List, search, or ask about invoices',
  triggerPatterns: ['show.*invoice', 'list.*invoice', 'my invoice'],
  parameters: { status: { type: 'string', required: false } },
  endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/invoices' },
};
const AGING_REPORT = {
  name: 'aging-report',
  description: 'Show accounts receivable aging',
  triggerPatterns: ['aging', 'who.*owe', 'accounts.*receivable'],
  parameters: {},
  endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/aging-report' },
};
const REVIEW_QUEUE = {
  name: 'review-queue',
  description: 'Show expenses that need human review',
  triggerPatterns: ['review', 'pending.*review', 'flagged'],
  parameters: {},
  endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/review-queue' },
};
const DAILY_BRIEFING = {
  name: 'daily-briefing',
  description: 'Morning briefing with revenue, receivables and deadlines',
  triggerPatterns: ['daily briefing', 'morning briefing'],
  parameters: {},
  endpoint: { method: 'INTERNAL', url: '' },
};
const GENERAL_QUESTION = {
  name: 'general-question',
  description: 'Answer any general financial or accounting question',
  triggerPatterns: [],
  parameters: { question: { type: 'string', required: true } },
  endpoint: { method: 'INTERNAL', url: '' },
};

const SKILLS = [
  QUERY_EXPENSES, QUERY_FINANCE, QUERY_INVOICES, AGING_REPORT,
  REVIEW_QUEUE, DAILY_BRIEFING, GENERAL_QUESTION,
];

async function classify(text: string) {
  const { classifyOnly } = await import('../server');
  return classifyOnly(text, 'tenant-maya', 'telegram', [], [], SKILLS as any, [], {});
}

describe('a bare topic word routes to its read-only skill, deterministically', () => {
  it.each([
    ['Expenses', 'query-expenses'],
    ['expenses.', 'query-expenses'],
    ['my expenses', 'query-expenses'],
    ['Show me expenses', 'query-expenses'],
    ['  Expenses!  ', 'query-expenses'],
    ['spending', 'query-expenses'],
    ['dépenses', 'query-expenses'],
    ['支出', 'query-expenses'],
    ['Balance', 'query-finance'],
    ['cash', 'query-finance'],
    ['cash balance', 'query-finance'],
    ['revenue', 'query-finance'],
    ['income', 'query-finance'],
    ['tax', 'query-finance'],
    ['税', 'query-finance'],
    ['余额', 'query-finance'],
    ['Invoices', 'query-invoices'],
    ['发票', 'query-invoices'],
    ['receivables', 'aging-report'],
    ['receipts', 'review-queue'],
    ['收据', 'review-queue'],
  ])('%j → %s at 0.85, without consulting the classifier', async (text, skill) => {
    const res: any = await classify(text);
    expect(res?.selectedSkill?.name).toBe(skill);
    expect(res?.confidence).toBe(0.85);
    expect(res?.extractedParams?.question).toBe(text);
    expect(res?.confirmBefore).toBe(false);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  it('0.85 clears every gate that could turn the answer into a plan preview', async () => {
    // The bug was a confirmation gate on a read-only question. Both
    // thresholds live in other modules; assert against them directly rather
    // than trusting that 0.85 "looks high enough".
    const { assessComplexity } = await import('../agent-planner');
    const res: any = await classify('Expenses');
    expect(res.confidence).toBeGreaterThanOrEqual(0.55); // CONFIDENCE_ESCALATION_THRESHOLD
    expect(assessComplexity('Expenses', res.selectedSkill, res.confidence)).toBe('simple');
  });

  it('a topic word carrying a qualifier is NOT shortcut', async () => {
    // "Expenses for March" is four words: it keeps its normal routing, which
    // here means the stubbed classifier.
    const res: any = await classify('Expenses for March');
    expect(res?.selectedSkill?.name).toBe('daily-briefing');
    expect(geminiFetch).toHaveBeenCalled();
  });

  it.each([
    // Trigger-pattern routing (Stage 2b) still owns these...
    ['how much did I spend on travel', 'query-expenses'],
    ['show me my invoices', 'query-invoices'],
    // ...and anything it does not claim still reaches the Stage-3 classifier,
    // which is stubbed to daily-briefing. Asserting the SKILL, not a
    // confidence value: "not 0.3" was satisfied by almost any outcome,
    // including the wrong skill.
    ['record $40 lunch', 'daily-briefing'],
  ])('%j still reaches normal routing → %s', async (text, skill) => {
    const res: any = await classify(text);
    expect(res?.selectedSkill?.name).toBe(skill);
  });

  it('the greeting shortcut still wins for "hello"', async () => {
    // Stage 2a runs first and must keep claiming greetings — "hello" is not a
    // topic word and must stay a conversational answer at 0.3.
    const res: any = await classify('hello');
    expect(res?.selectedSkill?.name).toBe('general-question');
    expect(res?.confidence).toBe(0.3);
    expect(geminiFetch).not.toHaveBeenCalled();
  });
});

describe('the bare-topic matcher is linear on input it rejects', () => {
  it('a long non-topic message is rejected in microseconds', async () => {
    // A SUCCEEDING match proves nothing — it stops at the first path that
    // works. The failing match is the one that has to exhaust the pattern, so
    // feed it a run the trailing class matches followed by a char it cannot.
    const { bareTopicSkillName } = await import('../server');
    const evil = 'show me ' + '!'.repeat(50_000) + 'z';
    const t0 = performance.now();
    expect(bareTopicSkillName(evil)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('...and on a failing match SHORT enough to clear the length gate', async () => {
    // The 50 kB case only proves BARE_TOPIC_MAX_CHARS (40) rejects it before a
    // regex ever runs — it says nothing about the patterns themselves. This
    // one is 39 chars and one word, so it passes both size gates and actually
    // reaches BARE_TOPIC_TRAIL_RE: a run the trailing class matches, ended by
    // a char it cannot.
    const { bareTopicSkillName } = await import('../server');
    const evil = '!'.repeat(38) + 'z';
    expect(evil.length).toBeLessThanOrEqual(40);
    expect(evil.split(/\s+/).length).toBeLessThanOrEqual(3);
    const t0 = performance.now();
    expect(bareTopicSkillName(evil)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('rejects a topic word embedded in a sentence', async () => {
    const { bareTopicSkillName } = await import('../server');
    expect(bareTopicSkillName('what are my expenses for Q3')).toBeNull();
    expect(bareTopicSkillName('delete all expenses')).toBeNull();
    expect(bareTopicSkillName('')).toBeNull();
  });
});
