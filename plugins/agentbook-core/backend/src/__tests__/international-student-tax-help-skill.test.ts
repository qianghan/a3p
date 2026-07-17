import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 4 (launch-pr8-student-au) — international-student-tax-help's AU
 * residency/visa content addition, plus the jurisdiction-independent
 * treaty-note bug fix (treatyNote used to be keyed on homeCountry alone,
 * with no jurisdiction check, so a Canada-jurisdiction student from China
 * was incorrectly shown "the US-China tax treaty").
 *
 * callGemini() is a same-module function in server.ts, not an injectable
 * ctx dependency (see scholarship-taxability-skill.test.ts's identical
 * note), so it's exercised via a mocked global.fetch — the system prompt
 * callGemini builds is recoverable from the request body's
 * `systemInstruction.parts[0].text` field.
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
    selectedSkill: { name: 'international-student-tax-help', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
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
  mockGeminiResponse('AgentBook is not a CPA, immigration advisor, or e-file agent.');
});

describe('international-student-tax-help — jurisdiction-specific system prompt', () => {
  it('AU jurisdiction: includes Australia/myTax/DASP content and does not fall through to the pure-US branch', async () => {
    await executeClassification(classification({ jurisdiction: 'au' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain('Australia');
    expect(system).toContain('myTax');
    expect(system).toContain('DASP');
    // The AU rules block deliberately contrasts with US mechanics (e.g. "no
    // Australian equivalent of FICA, Form 8843 ... the way F-1/J-1 students
    // ... need ... Form 1040-NR"), so those terms legitimately appear inside
    // AU's own text. What must NOT appear is content unique to the pure-US
    // else-branch: the Substantial Presence Test framing, the US-only
    // opening sentence, and the US/India treaty specifics.
    expect(system).not.toContain('Substantial Presence Test');
    expect(system).not.toContain('US nonresident-alien basics');
    expect(system).not.toContain('US-China');
    expect(system).not.toContain('US-India');
  });

  it('CA jurisdiction: gives the honest "not yet available" fallback, no US-specific content (regression guard for the pre-existing treaty-note bug)', async () => {
    await executeClassification(classification({ jurisdiction: 'ca' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("AgentBook does not yet have verified, Canada-specific international-student tax content");
    expect(system).not.toContain('FICA');
    expect(system).not.toContain('1040-NR');
    expect(system).not.toContain('Form 8843');
  });

  it('US jurisdiction + homeCountry cn: still contains the exact existing US-China treaty sentence (regression guard)', async () => {
    await executeClassification(classification({ jurisdiction: 'us', homeCountry: 'cn' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("the US-China tax treaty (Article 20) can exempt scholarship income");
  });

  it('US jurisdiction + homeCountry ca (Canadian citizen, US tax jurisdiction): gives the honest no-verified-treaty-specifics fallback, not fabricated content', async () => {
    await executeClassification(classification({ jurisdiction: 'us', homeCountry: 'ca' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).toContain("I don't have verified treaty specifics for your country memorized");
    expect(system).not.toContain('US-China');
  });

  it('CA jurisdiction + homeCountry cn: never mentions the US-China tax treaty (confirms the pre-existing jurisdiction-independent bug is fixed)', async () => {
    await executeClassification(classification({ jurisdiction: 'ca', homeCountry: 'cn' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).not.toContain('US-China tax treaty');
  });

  it('UK jurisdiction (a real value elsewhere in this codebase, e.g. jurisdiction-currency.ts): does not render a literal "Treaty specifics: null" — falls through to the US-labeled branch with the honest generic fallback', async () => {
    // 'uk' isn't 'au' or 'ca', so it falls through to the same rules branch
    // as 'us'. Before the self-review fix, treatyNote was null'd for any
    // jurisdiction !== 'us', which — since this branch always interpolates
    // treatyNote — would have rendered the literal string "Treaty specifics:
    // null" for this jurisdiction.
    await executeClassification(classification({ jurisdiction: 'uk', homeCountry: 'fr' }), 'what does my visa status mean for my taxes?', 'tenant-1', 'api');
    const system = capturedSystemPrompt();
    expect(system).not.toContain('Treaty specifics: null');
    expect(system).toContain("I don't have verified treaty specifics for your country memorized");
  });
});
