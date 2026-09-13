import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PARITY-5, Task 2 — wire real tax-deadline data (from the same
 * /api/v1/agentbook-tax/tax/quarterly route the already-correct
 * `quarterly-payments` chat skill uses) into the `daily-briefing` chat
 * skill's Gemini prompt, so a real jurisdiction-aware upcoming tax
 * deadline can become part of the briefing's "one concrete action item."
 *
 * Task 13 (chat-quality PR E) — the briefing's financial snapshot is now read
 * straight from the ledger via `buildFinancialContext(tenantId)` instead of
 * self-calling `/api/v1/agentbook-core/financial-snapshot`: that Express route
 * was never ported to Next, so in production the fetch always failed and the
 * user's morning briefing told them their own numbers were "unavailable".
 * Sections that fail to load are now OMITTED from the prompt rather than
 * narrated as missing, and the system prompt tells the model not to mention
 * gaps. Hence the db mock below must cover every model buildFinancialContext
 * reads — and its `findMany`s apply their `where` clause, because a fixed
 * array that ignores `where` cannot fail on a bug whose cause IS the filter.
 *
 * callGemini() is a same-module function in server.ts, not an injectable
 * ctx dependency (see international-student-tax-help-skill.test.ts's
 * identical note), so it's exercised via a single mocked global.fetch that
 * dispatches by URL: the proactive-alerts and tax/quarterly calls (both via
 * baseUrls' localhost fallbacks since no AGENTBOOK_*_URL env vars are set in
 * tests), plus the Gemini generativelanguage.googleapis.com call itself. The
 * prompts callGemini builds are recoverable from the request body's
 * `contents[0].parts[0].text` (user) and `systemInstruction.parts[0].text`
 * (system) fields.
 */

const mockAbConversationCreate = vi.fn(async () => ({}));

// Hoisted so the (hoisted) vi.mock factory and the test bodies share one set
// of fixtures.
const fixtures = vi.hoisted(() => {
  /**
   * Apply a Prisma-shaped `where` to a fixture row. Supports the shapes
   * buildFinancialContext actually passes: scalar equality (`tenantId`,
   * `deletedAt: null`, `isPersonal: false`, `accountType`, `code`, `active`),
   * `{ in: [...] }`, and the nested relation filter `{ entry: { tenantId } }`.
   */
  function matchesWhere(row: any, where: any): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('in' in (cond as any)) {
          if (!(cond as any).in.includes(row?.[key])) return false;
          continue;
        }
        if (!matchesWhere(row?.[key] ?? {}, cond)) return false;
        continue;
      }
      if (row?.[key] !== cond) return false;
    }
    return true;
  }

  /** A model mock whose reads honour their `where` clause. */
  function model(rows: any[] = []) {
    return {
      findMany: async (args: any = {}) => rows.filter((r) => matchesWhere(r, args?.where)),
      findFirst: async (args: any = {}) => rows.find((r) => matchesWhere(r, args?.where)) ?? null,
    };
  }

  const now = new Date();
  const expenses = [
    // The only row tenant-1's snapshot may legitimately count.
    { id: 'e1', tenantId: 'tenant-1', amountCents: 12_345, isPersonal: false, deletedAt: null, date: now, categoryId: 'cat-1', vendor: { name: 'Figma' } },
    // Each of these is excluded by one clause of the `where`. A mock that
    // ignored `where` would leak them into tenant-1's totals.
    { id: 'e2', tenantId: 'tenant-2', amountCents: 99_999, isPersonal: false, deletedAt: null, date: now, categoryId: 'cat-1', vendor: { name: 'Other' } },
    { id: 'e3', tenantId: 'tenant-1', amountCents: 55_555, isPersonal: true, deletedAt: null, date: now, categoryId: null, vendor: null },
    { id: 'e4', tenantId: 'tenant-1', amountCents: 77_777, isPersonal: false, deletedAt: now, date: now, categoryId: null, vendor: null },
  ];

  return { model, expenses, TENANT_1_EXPENSE_CENTS: 12_345, OTHER_TENANT_EXPENSE_CENTS: 99_999 };
});

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { create: (...args: any[]) => mockAbConversationCreate(...args) },
    // callGemini() falls back to this only when GEMINI_API_KEY is unset;
    // tests always set the env var, so this is never actually read.
    abLLMProviderConfig: { findFirst: vi.fn(async () => null) },
    // executeClassification's finally-block skill-metrics write — fire-and-
    // forget in production (errors are swallowed), mocked here just to keep
    // test output free of the caught-error stderr noise.
    abSkillRun: { create: vi.fn(async () => ({})) },
    // Everything buildFinancialContext(tenantId) reads.
    abTenantConfig: fixtures.model([]),
    abAccount: fixtures.model([]),
    abJournalLine: fixtures.model([]),
    abExpense: fixtures.model(fixtures.expenses),
    abClient: fixtures.model([]),
    abInvoice: fixtures.model([]),
    abTaxEstimate: fixtures.model([]),
    abRecurringRule: fixtures.model([]),
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

function classification() {
  return {
    selectedSkill: { name: 'daily-briefing', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams: {},
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

function jsonOk(body: any) {
  return { ok: true, json: async () => body };
}

type FetchPlan = {
  quarterlyThrows?: boolean;
  alertsThrows?: boolean;
  quarterlyPayments?: any[];
};

function setupFetch(plan: FetchPlan = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonOk({ candidates: [{ content: { parts: [{ text: 'Briefing text.' }] } }] });
    }
    if (url.includes('proactive-alerts')) {
      if (plan.alertsThrows) {
        throw new Error('expense service down');
      }
      return jsonOk({ success: true, data: [] });
    }
    if (url.includes('tax/quarterly')) {
      if (plan.quarterlyThrows) {
        throw new Error('tax service down');
      }
      return jsonOk({ success: true, data: { payments: plan.quarterlyPayments ?? [] } });
    }
    return jsonOk({ success: false });
  });
}

// Recovers the prompts executeClassification's callGemini() call built, from
// the mocked fetch's Gemini request body.
function capturedGeminiBody(): any {
  const call = mockFetch.mock.calls.find(([url]: any[]) => String(url).includes('generativelanguage.googleapis.com'));
  expect(call).toBeTruthy();
  const [, opts] = call as any[];
  return JSON.parse((opts as any).body);
}

function capturedUserPrompt(): string {
  return capturedGeminiBody().contents[0].parts[0].text as string;
}

function capturedSystemPrompt(): string {
  return capturedGeminiBody().systemInstruction.parts[0].text as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockAbConversationCreate.mockResolvedValue({});
});

describe('daily-briefing — tax-deadline countdown', () => {
  it('includes the nearest upcoming, unpaid deadline in the Gemini prompt', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setupFetch({ quarterlyPayments: [{ amountDueCents: 150_000, amountPaidCents: 0, deadline: future.toISOString() }] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Next quarterly tax deadline:');
    expect(prompt).toContain('$1500.00');
    expect(prompt).toContain(future.toISOString().slice(0, 10));
  });

  it('picks the nearest of multiple unpaid future deadlines', async () => {
    const nearer = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const farther = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    setupFetch({
      quarterlyPayments: [
        { amountDueCents: 200_000, amountPaidCents: 0, deadline: farther.toISOString() },
        { amountDueCents: 150_000, amountPaidCents: 0, deadline: nearer.toISOString() },
      ],
    });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('$1500.00');
    expect(prompt).toContain(nearer.toISOString().slice(0, 10));
    expect(prompt).not.toContain('$2000.00');
  });

  // Task 13: a deadline section that has nothing real to say is dropped from
  // the prompt entirely — the model is never handed the word "unavailable"
  // to repeat back at the user.
  it('omits the deadline line when the only deadline is in the past', async () => {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    setupFetch({ quarterlyPayments: [{ amountDueCents: 150_000, amountPaidCents: 0, deadline: past.toISOString() }] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).not.toContain('Next quarterly tax deadline');
  });

  it('omits the deadline line when the only future deadline is already fully paid', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setupFetch({ quarterlyPayments: [{ amountDueCents: 150_000, amountPaidCents: 150_000, deadline: future.toISOString() }] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).not.toContain('Next quarterly tax deadline');
  });

  it('omits the deadline line when there are no quarterly payment records at all', async () => {
    setupFetch({ quarterlyPayments: [] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).not.toContain('Next quarterly tax deadline');
  });

  it('a failing tax-quarterly fetch (best-effort Promise.allSettled) does not break the rest of the briefing', async () => {
    setupFetch({ quarterlyThrows: true });

    const result = await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    expect(result.responseData.message).toBe('Briefing text.');
    const prompt = capturedUserPrompt();
    expect(prompt).not.toContain('Next quarterly tax deadline');
    // The other two data sources still made it into the prompt.
    expect(prompt).toContain('Financial snapshot:');
    expect(prompt).toContain('Alerts:');
  });
});

describe('daily-briefing — real data, no narrated gaps (Task 13)', () => {
  it('reads the snapshot from the ledger directly (the /financial-snapshot self-call has no Next route)', () => {
    const src = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const block = src.slice(
      src.indexOf("if (selectedSkill.name === 'daily-briefing') {"),
      src.indexOf('Daily-briefing error'),
    );
    expect(block).not.toContain('/api/v1/agentbook-core/financial-snapshot');
    expect(block).toContain('buildFinancialContext(tenantId)');
  });

  it('never puts the word "unavailable" in front of the model, and tells it not to mention gaps', async () => {
    setupFetch({ alertsThrows: true, quarterlyPayments: [] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    // The FACTS handed to the model carry no gap-talk at all. (The check is
    // scoped to the user prompt because the system prompt's instruction
    // necessarily contains the word it is forbidding the model to use.)
    const facts = capturedUserPrompt();
    expect(facts).not.toMatch(/unavailable/i);
    expect(facts).not.toMatch(/missing|couldn't load|not available/i);
    expect(facts).not.toContain('Alerts:'); // the failed section is omitted, not narrated
    expect(facts).not.toContain('Next quarterly tax deadline');
    expect(capturedSystemPrompt()).toMatch(/Do not mention missing/);
  });

  it('puts the ledger’s own numbers in the prompt, scoped to this tenant', async () => {
    setupFetch({ quarterlyPayments: [] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Financial snapshot:');
    expect(prompt).toContain(`"totalExpenseCents":${fixtures.TENANT_1_EXPENSE_CENTS}`);
    expect(prompt).not.toContain(String(fixtures.OTHER_TENANT_EXPENSE_CENTS));
  });
});
