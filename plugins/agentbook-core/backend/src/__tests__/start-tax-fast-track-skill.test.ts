import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR-3 (tax-fast-track-foundation), Task 4 — start-tax-fast-track's own
 * INTERNAL handler (server.ts, alongside tax-filing-start's handler).
 *
 * Depends on Task 1 (session data-layer helpers) + Task 2 (pack) — NOT
 * Task 3's agent-brain.ts session-recovery branch. This skill only ever
 * runs on the FIRST message, before any AbTaxQuestionnaireSession exists,
 * so these tests mock createTaxQuestionnaireSession/updateTaxQuestionnaireSession
 * + the pack loader + a mocked callGemini (via a mocked global.fetch, since
 * callGemini is a same-module function in server.ts, not an injectable ctx
 * dependency the way agent-brain.ts's tests use it).
 *
 * See:
 *   docs/superpowers/specs/2026-07-13-tax-fast-track-foundation-design.md
 *   docs/superpowers/plans/2026-07-13-tax-fast-track-foundation.md (Task 4)
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockAbPastTaxFilingFindMany = vi.fn();
const mockAbConversationCreate = vi.fn(async (..._args: any[]) => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abPastTaxFiling: { findMany: (...args: any[]) => mockAbPastTaxFilingFindMany(...args) },
    abConversation: { create: (...args: any[]) => mockAbConversationCreate(...args) },
    // callGemini() (real, un-mocked — exercised via a mocked fetch below)
    // falls back to this only when GEMINI_API_KEY is unset; tests always set
    // the env var, so this is never actually read, but it's here so a stray
    // code path doesn't throw on an undefined property.
    abLLMProviderConfig: { findFirst: vi.fn(async () => null) },
  },
}));

const sessionHelpers = {
  createTaxQuestionnaireSession: vi.fn(async (_tenantId: string, _taxYear: number, _jurisdiction: string, _region: string | null, _trigger: string, _sourceFilingId: string | null) => ({
    id: 'tqs-new', version: 0,
  })),
  updateTaxQuestionnaireSession: vi.fn(async (_id: string, _version: number, _data: any) => true),
};
vi.mock('../tax-questionnaire-session.js', () => sessionHelpers);

const packMock = {
  jurisdiction: 'us',
  nextQuestionPrompt: vi.fn(() => 'SYSTEM PROMPT'),
  parseNextQuestionResponse: vi.fn((parsed: unknown) => parsed as any),
};
const jurisdictionsLoader = {
  getTaxQuestionnairePack: vi.fn(() => packMock),
};
vi.mock('@agentbook/jurisdictions/tax-questionnaire-loader', () => jurisdictionsLoader);

vi.mock('../personal-profile-context.js', () => ({
  buildPersonalProfileContext: vi.fn(async () => 'PROFILE CONTEXT'),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// server.ts (and its own import of agent-brain.ts) transitively imports
// '../tax-questionnaire-session.js' and '@agentbook/jurisdictions/tax-
// questionnaire-loader' — a static top-level `import ... from '../server'`
// here would be hoisted above this file's own `const sessionHelpers = {...}`
// / `const packMock = {...}` declarations (ES import hoisting), causing the
// vi.mock factories above to reference those consts before initialization.
// Mirrors tax-questionnaire-recovery.test.ts's own dynamic-import workaround
// for the identical hoisting hazard.
async function loadServer() {
  return import('../server');
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function classification(extractedParams: Record<string, any> = {}, tenantConfig: Record<string, any> = { jurisdiction: 'us', region: 'CA' }) {
  return {
    selectedSkill: { name: 'start-tax-fast-track', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams,
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig,
  } as any;
}

function filing(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'filing-1',
    tenantId: 'tenant-1',
    taxYear: 2024,
    jurisdiction: 'us',
    region: 'CA',
    formType: '1040',
    status: 'confirmed',
    extractedData: { formType: '1040', taxYear: 2024, jurisdiction: 'us', totalIncomeCents: 500000, formFields: {}, attachedForms: {}, confidence: 0.9 },
    ...overrides,
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
  sessionHelpers.createTaxQuestionnaireSession.mockResolvedValue({ id: 'tqs-new', version: 0 });
  sessionHelpers.updateTaxQuestionnaireSession.mockResolvedValue(true);
  packMock.nextQuestionPrompt.mockReturnValue('SYSTEM PROMPT');
  packMock.parseNextQuestionResponse.mockImplementation((parsed: unknown) => parsed as any);
  jurisdictionsLoader.getTaxQuestionnairePack.mockReturnValue(packMock);
  mockAbConversationCreate.mockResolvedValue({});
});

describe('start-tax-fast-track — confirmed-status filtering', () => {
  it('filters to status === "confirmed" itself (listPastFilings does not pre-filter) and picks the most recent confirmed filing by taxYear', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([
      filing({ id: 'f-error', taxYear: 2025, status: 'error' }),
      filing({ id: 'f-uploaded', taxYear: 2025, status: 'uploaded' }),
      filing({ id: 'f-parsing', taxYear: 2024, status: 'parsing' }),
      filing({ id: 'f-confirmed-2023', taxYear: 2023, status: 'confirmed' }),
      filing({ id: 'f-confirmed-2022', taxYear: 2022, status: 'confirmed' }),
    ]);
    mockGeminiResponse('{"question": "What is your filing status this year?"}');

    await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    // The most recent CONFIRMED filing (2023), not the newer-but-unconfirmed
    // 2025 rows and not the older 2022 confirmed one.
    expect(sessionHelpers.createTaxQuestionnaireSession).toHaveBeenCalledWith(
      'tenant-1', 2025, 'us', 'CA', 'fast_track', 'f-confirmed-2023',
    );
  });
});

describe('start-tax-fast-track — blocked path (no confirmed filing)', () => {
  it('stays at confidence: 1 and points at the upload flow when there is no confirmed filing at all', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([
      filing({ id: 'f-uploaded', status: 'uploaded' }),
      filing({ id: 'f-error', status: 'error' }),
    ]);

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(result.responseData.confidence).toBe(1);
    expect(result.responseData.message).toMatch(/upload|past filing/i);
    expect(sessionHelpers.createTaxQuestionnaireSession).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled(); // no callGemini call on the blocked path
  });

  it('also stays at confidence: 1 when there are zero filings at all', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([]);

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(result.responseData.confidence).toBe(1);
    expect(sessionHelpers.createTaxQuestionnaireSession).not.toHaveBeenCalled();
  });
});

describe('start-tax-fast-track — happy path', () => {
  it('produces a real first question and seeds qaHistory/askedCount to the exact contract shape Task 3 depends on', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse('{"question": "What is your filing status this year?"}');

    const result = await executeClassification(classification({ taxYear: 2025 }), "use my previous filing to do this year's taxes", 'tenant-1', 'api');

    expect(sessionHelpers.createTaxQuestionnaireSession).toHaveBeenCalledWith(
      'tenant-1', 2025, 'us', 'CA', 'fast_track', 'filing-1',
    );

    // The exact contract: qaHistory's LAST (and only) entry is a "pending"
    // placeholder — {question, answer: ''} — with askedCount: 1, not
    // qaHistory: [] / askedCount: 0. This is what agent-brain.ts's Step 1b
    // session-recovery branch depends on to recover "which question is
    // being answered" on the next turn.
    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledWith('tqs-new', 0, {
      qaHistory: [{ question: 'What is your filing status this year?', answer: '' }],
      askedCount: 1,
    });

    expect(result.responseData.confidence).toBe(1);
    expect(result.responseData.message).toBe('What is your filing status this year?');
    expect(result.responseData.sessionId).toBe('tqs-new');

    // Prompt built from the confirmed filing's extractedData + the
    // already-built profile markdown block, reused as-is (no new
    // context-building logic).
    expect(packMock.nextQuestionPrompt).toHaveBeenCalledWith({
      qaHistory: [],
      priorFiling: filing().extractedData,
      profile: 'PROFILE CONTEXT',
    });
  });

  it("defaults taxYear to 2025 when the classifier didn't extract one, matching tax-filing-start's own default", async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse('{"question": "Any new dependents?"}');

    await executeClassification(classification({}), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(sessionHelpers.createTaxQuestionnaireSession).toHaveBeenCalledWith(
      'tenant-1', 2025, 'us', 'CA', 'fast_track', 'filing-1',
    );
  });

  it('handles a done:true response on the very first question as a legitimate zero-question completion, not a failure', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse('{"done": true}');

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledWith('tqs-new', 0, { status: 'completed' });
    expect(result.responseData.confidence).toBe(1);
    expect(result.responseData.message.toLowerCase()).toContain('ready');
  });
});

describe('start-tax-fast-track — first-question callGemini() failure', () => {
  it('callGemini() returning falsy (its real non-throwing failure mode) abandons the just-created session and asks the user to try again, at confidence: 1', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse(null); // fetch !ok -> callGemini resolves null, never throws

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(sessionHelpers.createTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
    // Abandoned immediately — not left in_progress with an empty qaHistory
    // for agent-brain.ts's Step 1b to stumble into on the user's next
    // message (see the handler's own comment for the full rationale).
    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledWith('tqs-new', 0, { status: 'abandoned' });
    expect(result.responseData.confidence).toBe(1);
    expect(result.responseData.message).toMatch(/try|wrong/i);
  });

  it('a malformed-JSON response is handled the same way as a null callGemini return', async () => {
    const { executeClassification } = await loadServer();
    mockAbPastTaxFilingFindMany.mockResolvedValueOnce([filing()]);
    mockGeminiResponse('this is not json at all {{{');

    const result = await executeClassification(classification(), 'fast track my taxes from last year', 'tenant-1', 'api');

    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledWith('tqs-new', 0, { status: 'abandoned' });
    expect(result.responseData.confidence).toBe(1);
  });
});
