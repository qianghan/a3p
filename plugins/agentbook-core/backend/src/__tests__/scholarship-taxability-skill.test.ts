import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 3 (launch-pr8-student-au) — scholarship-taxability's AU (Division
 * 51-10) content addition.
 *
 * callGemini() is a same-module function in server.ts, not an injectable
 * ctx dependency (see start-tax-fast-track-skill.test.ts's identical note),
 * so it's exercised via a mocked global.fetch — the system prompt callGemini
 * builds is recoverable from the request body's `systemInstruction.parts[0]
 * .text` field.
 */

const mockAbConversationCreate = vi.fn(async (..._args: any[]) => ({}));

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

function classification(tenantConfig: Record<string, any> = { jurisdiction: 'us' }) {
  return {
    selectedSkill: { name: 'scholarship-taxability', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams: {},
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig,
  } as any;
}

function mockGeminiResponse(text: string | null) {
  if (text === null) {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    return;
  }
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });
}

// Recovers the `system` string executeClassification's callGemini() call
// built, from the mocked fetch's request body.
function capturedSystemPrompt(): string {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [, opts] = mockFetch.mock.calls[0];
  const body = JSON.parse((opts as any).body);
  return body.systemInstruction.parts[0].text as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  mockAbConversationCreate.mockResolvedValue({});
  mockGeminiResponse('Not taxable — spend it on tuition and required fees and it stays tax-free.');
});

describe('scholarship-taxability — jurisdiction-specific system prompt', () => {
  it('AU jurisdiction: labels the jurisdiction Australia and includes the Division 51-10 rules', async () => {
    await executeClassification(classification({ jurisdiction: 'au' }), 'is my scholarship taxable?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain('Australia');
    expect(system).not.toContain('the United States');
    expect(system).not.toContain('is Canada');
    expect(system).toContain('Division 51-10');
    // AU-specific content should be present alongside the label
    expect(system).toContain('HECS-HELP');
    expect(system).toContain('Youth Allowance');
  });

  it('CA jurisdiction: unchanged — labels the jurisdiction Canada, still includes the existing CRA content, no AU-driven change to CA\'s own answer', async () => {
    await executeClassification(classification({ jurisdiction: 'ca' }), 'is my scholarship taxable?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("The user's tax jurisdiction is Canada");
    expect(system).toContain('CRA');
    expect(system).toContain('line 13010');
    expect(system).toContain('T2202');
  });

  it('US jurisdiction: unchanged — labels the jurisdiction the United States, still includes the existing IRS content', async () => {
    await executeClassification(classification({ jurisdiction: 'us' }), 'is my scholarship taxable?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("The user's tax jurisdiction is the United States");
    expect(system).toContain('IRS Pub 970');
    expect(system).toContain('AOTC');
  });

  it('defaults to US when tenantConfig.jurisdiction is missing', async () => {
    await executeClassification(classification({}), 'is my scholarship taxable?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("The user's tax jurisdiction is the United States");
  });
});
