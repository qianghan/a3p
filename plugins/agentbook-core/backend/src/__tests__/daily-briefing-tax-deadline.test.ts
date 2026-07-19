import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PARITY-5, Task 2 — wire real tax-deadline data (from the same
 * /api/v1/agentbook-tax/tax/quarterly route the already-correct
 * `quarterly-payments` chat skill uses) into the `daily-briefing` chat
 * skill's Gemini prompt, so a real jurisdiction-aware upcoming tax
 * deadline can become part of the briefing's "one concrete action item."
 *
 * callGemini() is a same-module function in server.ts, not an injectable
 * ctx dependency (see international-student-tax-help-skill.test.ts's
 * identical note), so it's exercised via a single mocked global.fetch that
 * dispatches by URL: the financial-snapshot, proactive-alerts, and
 * tax/quarterly calls (all via baseUrls' localhost fallbacks since no
 * AGENTBOOK_*_URL env vars are set in tests), plus the Gemini
 * generativelanguage.googleapis.com call itself. The prompt callGemini
 * builds is recoverable from the request body's
 * `contents[0].parts[0].text` field.
 */

const mockAbConversationCreate = vi.fn(async () => ({}));

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
  quarterlyPayments?: any[];
};

function setupFetch(plan: FetchPlan = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonOk({ candidates: [{ content: { parts: [{ text: 'Briefing text.' }] } }] });
    }
    if (url.includes('financial-snapshot')) {
      return jsonOk({ success: true, data: { cashCents: 1_000_000 } });
    }
    if (url.includes('proactive-alerts')) {
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

// Recovers the `briefingUser` string executeClassification's callGemini()
// call built, from the mocked fetch's Gemini request body.
function capturedUserPrompt(): string {
  const call = mockFetch.mock.calls.find(([url]: any[]) => String(url).includes('generativelanguage.googleapis.com'));
  expect(call).toBeTruthy();
  const [, opts] = call as any[];
  const body = JSON.parse((opts as any).body);
  return body.contents[0].parts[0].text as string;
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

  it('says "none upcoming or unavailable" when the only deadline is in the past', async () => {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    setupFetch({ quarterlyPayments: [{ amountDueCents: 150_000, amountPaidCents: 0, deadline: past.toISOString() }] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Next quarterly tax deadline: none upcoming or unavailable.');
  });

  it('says "none upcoming or unavailable" when the only future deadline is already fully paid', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setupFetch({ quarterlyPayments: [{ amountDueCents: 150_000, amountPaidCents: 150_000, deadline: future.toISOString() }] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Next quarterly tax deadline: none upcoming or unavailable.');
  });

  it('says "none upcoming or unavailable" when there are no quarterly payment records at all', async () => {
    setupFetch({ quarterlyPayments: [] });

    await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Next quarterly tax deadline: none upcoming or unavailable.');
  });

  it('a failing tax-quarterly fetch (best-effort Promise.allSettled) does not break the rest of the briefing', async () => {
    setupFetch({ quarterlyThrows: true });

    const result = await executeClassification(classification(), 'catch me up', 'tenant-1', 'api');

    expect(result.responseData.message).toBe('Briefing text.');
    const prompt = capturedUserPrompt();
    expect(prompt).toContain('Next quarterly tax deadline: none upcoming or unavailable.');
    // The other two data sources still made it into the prompt.
    expect(prompt).toContain('Financial snapshot:');
    expect(prompt).toContain('Alerts:');
  });
});
