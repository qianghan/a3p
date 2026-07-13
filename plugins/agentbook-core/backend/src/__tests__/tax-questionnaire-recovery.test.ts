import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 3 — the tax-questionnaire session-recovery branch in agent-brain.ts.
 *
 * Mirrors the exit-path matrix from the design spec's Test plan + the plan's
 * Task 3 section: happy path, done:true, the 8-question cap, cancel keywords
 * (including the two-word "never mind" form), callGemini() returning falsy
 * (its real non-throwing failure mode), a parse/pack throw, the
 * consecutiveFailures>=3 abandon cap, no-active-session fallthrough, and a
 * version-conflict update with no retry.
 *
 * See:
 *   docs/superpowers/specs/2026-07-13-tax-fast-track-foundation-design.md
 *   docs/superpowers/plans/2026-07-13-tax-fast-track-foundation.md (Task 3)
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const dbMock = {
  abConversation: {
    findFirst: vi.fn(async () => null as any),
    findMany: vi.fn(async () => [] as any[]),
    create: vi.fn(async () => ({})),
  },
  abAgentSession: {
    findFirst: vi.fn(async () => null as any), // no active AbAgentSession in any of these tests
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  abConvThread: {
    findFirst: vi.fn(async () => null as any),
    create: vi.fn(async (args: any) => ({ id: 'thread-1', turns: [], ...args.data })),
    update: vi.fn(async () => ({})),
  },
  abTenantConfig: { findFirst: vi.fn(async () => null as any) },
  abUserMemory: { findMany: vi.fn(async () => [] as any[]) },
  abSkillManifest: { findMany: vi.fn(async () => [] as any[]) },
  abEvent: { create: vi.fn(async () => ({})) },
  abPastTaxFiling: { findUnique: vi.fn(async () => null as any) },
  $executeRaw: vi.fn(async () => 1),
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

// The tax-questionnaire session data-layer helpers (Task 1) get their own
// dedicated unit tests in tax-questionnaire-session.test.ts — here we mock
// them directly so this file tests ONLY agent-brain.ts's branch logic (what
// it decides to call and with what arguments), not the raw-SQL/version-guard
// mechanics underneath.
const sessionHelpers = {
  getActiveTaxQuestionnaireSession: vi.fn(async (_tenantId: string) => null as any),
  updateTaxQuestionnaireSession: vi.fn(async (_id: string, _version: number, _data: any) => true),
};
vi.mock('../tax-questionnaire-session.js', () => sessionHelpers);

// The jurisdiction pack (Task 2) also gets its own dedicated unit tests —
// mock the loader so this file controls exactly what nextQuestionPrompt()/
// parseNextQuestionResponse() return per test.
const packMock = {
  jurisdiction: 'us',
  nextQuestionPrompt: vi.fn(() => 'SYSTEM PROMPT'),
  parseNextQuestionResponse: vi.fn((parsed: unknown) => parsed as any),
};
const jurisdictionsLoader = {
  getTaxQuestionnairePack: vi.fn(() => packMock),
};
vi.mock('@agentbook/jurisdictions/tax-questionnaire-loader', () => jurisdictionsLoader);

// Keep the personal-profile / past-filing context builders out of scope for
// this file — they have their own tests, and pulling in their real db calls
// here would just be extra noise for tests about the branch's own decisions.
vi.mock('../personal-profile-context.js', () => ({
  buildPersonalProfileContext: vi.fn(async () => ''),
}));
vi.mock('../past-filing-context.js', () => ({
  buildPastFilingContext: vi.fn(async () => ''),
}));

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'tqs-1',
    tenantId: 'tenant-A',
    taxYear: 2025,
    jurisdiction: 'us',
    region: null,
    trigger: 'fast_track',
    sourceFilingId: null,
    status: 'in_progress',
    qaHistory: [{ question: 'What is your filing status?', answer: '' }],
    askedCount: 1,
    consecutiveFailures: 0,
    version: 3,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function makeCtx(callGemini: (sys: string, user: string, max?: number) => Promise<string | null>) {
  return {
    skills: [],
    callGemini,
    baseUrls: {},
    classifyAndExecuteV1: vi.fn(async () => null),
  };
}

function makeReq(text: string, tenantId = 'tenant-A') {
  return { text, tenantId, channel: 'test' };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
  sessionHelpers.updateTaxQuestionnaireSession.mockResolvedValue(true);
  packMock.nextQuestionPrompt.mockReturnValue('SYSTEM PROMPT');
  packMock.parseNextQuestionResponse.mockImplementation((parsed: unknown) => parsed as any);
  jurisdictionsLoader.getTaxQuestionnairePack.mockReturnValue(packMock);
  dbMock.abAgentSession.findFirst.mockResolvedValue(null);
  dbMock.abConvThread.findFirst.mockResolvedValue(null);
  dbMock.abPastTaxFiling.findUnique.mockResolvedValue(null);
});

describe('tax-questionnaire session recovery (agent-brain.ts)', () => {
  it('happy path: a real answer grows qaHistory, increments askedCount, asks the next question, stays in_progress', async () => {
    const session = makeSession(); // qaHistory has 1 pending question, askedCount 1
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    const callGemini = vi.fn(async () => '{"question": "Do you have any new dependents this year?"}');

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(resp.data.message).toBe('Do you have any new dependents this year?');
    expect(resp.data.skillUsed).toBe('tax-questionnaire');

    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
    const [id, version, data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(id).toBe('tqs-1');
    expect(version).toBe(3);
    expect(data.status).toBe('in_progress');
    expect(data.consecutiveFailures).toBe(0);
    expect(data.askedCount).toBe(2); // incremented from 1
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(data.qaHistory).toEqual([
      { question: 'What is your filing status?', answer: 'Single, no changes' },
      { question: 'Do you have any new dependents this year?', answer: '' },
    ]);
  });

  it('done:true from the pack marks the session completed', async () => {
    const session = makeSession();
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    const callGemini = vi.fn(async () => '{"done": true}');

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(resp.data.message.toLowerCase()).toContain('ready');

    const [, , data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(data.status).toBe('completed');
    expect(data.askedCount).toBeUndefined(); // not advanced past the final answered question
    expect(data.qaHistory).toEqual([
      { question: 'What is your filing status?', answer: 'Single, no changes' },
    ]);
  });

  it('askedCount hitting 8 marks completed even without done:true', async () => {
    const session = makeSession({ askedCount: 8 });
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    // Pack still returns a real question — the 8-question safety cap should
    // override it and mark the session completed anyway.
    const callGemini = vi.fn(async () => '{"question": "One more thing?"}');

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Final answer') as any,
      makeCtx(callGemini) as any,
    );

    const [, , data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(data.status).toBe('completed');
    expect(data.askedCount).toBeUndefined();
    expect(data.qaHistory).toEqual([
      { question: 'What is your filing status?', answer: 'Final answer' },
    ]);
    expect(resp.data.message.toLowerCase()).toContain('ready');
  });

  it.each(['cancel', 'stop', 'nevermind', 'never mind', 'STOP'])(
    'cancel keyword %j marks the session abandoned without touching qaHistory or expiresAt',
    async (keyword) => {
      const session = makeSession();
      sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
      const callGemini = vi.fn(async () => '{"question": "should not be called"}');

      const { handleAgentMessage } = await import('../agent-brain');
      const resp = await handleAgentMessage(makeReq(keyword) as any, makeCtx(callGemini) as any);

      expect(resp.success).toBe(true);
      expect(resp.data.message.toLowerCase()).toContain('cancel');
      expect(callGemini).not.toHaveBeenCalled();

      expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
      const [id, version, data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
      expect(id).toBe('tqs-1');
      expect(version).toBe(3);
      expect(data).toEqual({ status: 'abandoned' });
    },
  );

  it('callGemini() returning null increments consecutiveFailures with no other mutation, stays in_progress', async () => {
    const session = makeSession({ consecutiveFailures: 0 });
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    const callGemini = vi.fn(async () => null); // real non-throwing failure mode

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(resp.data.message.toLowerCase()).toMatch(/try|wrong/);

    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
    const [id, version, data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(id).toBe('tqs-1');
    expect(version).toBe(3);
    expect(data).toEqual({ consecutiveFailures: 1 });
  });

  it('a malformed-JSON throw is handled the same way as a null callGemini return', async () => {
    const session = makeSession({ consecutiveFailures: 0 });
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    const callGemini = vi.fn(async () => 'this is not json at all {{{');

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
    const [, , data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(data).toEqual({ consecutiveFailures: 1 });
  });

  it('consecutiveFailures reaching 3 marks the session abandoned', async () => {
    const session = makeSession({ consecutiveFailures: 2 });
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    const callGemini = vi.fn(async () => null);

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(resp.data.message.toLowerCase()).toContain('paused');

    const [, , data] = sessionHelpers.updateTaxQuestionnaireSession.mock.calls[0];
    expect(data).toEqual({ consecutiveFailures: 3, status: 'abandoned' });
  });

  it('no active session: this branch does nothing and the message falls through to normal classification', async () => {
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
    const classifyAndExecuteV1 = vi.fn(async () => ({
      selectedSkill: 'general-question',
      confidence: 0.9,
      skillUsed: 'general-question',
      responseData: { message: 'handled by normal classification', skillUsed: 'general-question', confidence: 0.9 },
    }));

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('what is my net worth') as any,
      {
        skills: [],
        callGemini: vi.fn(async () => null),
        baseUrls: {},
        classifyAndExecuteV1,
      } as any,
    );

    expect(sessionHelpers.updateTaxQuestionnaireSession).not.toHaveBeenCalled();
    expect(classifyAndExecuteV1).toHaveBeenCalledTimes(1);
    expect(resp.data.message).toBe('handled by normal classification');
  });

  it('a version conflict on update surfaces the no-retry conflict message', async () => {
    const session = makeSession();
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    sessionHelpers.updateTaxQuestionnaireSession.mockResolvedValue(false); // simulate a lost race
    const callGemini = vi.fn(async () => '{"question": "Do you have any new dependents this year?"}');

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(
      makeReq('Single, no changes') as any,
      makeCtx(callGemini) as any,
    );

    expect(resp.success).toBe(true);
    expect(resp.data.message).toBe('Session was modified by another process. Please try again.');
    // No retry — updateTaxQuestionnaireSession was attempted exactly once.
    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
  });

  it('a version conflict on the cancel path also surfaces the no-retry conflict message', async () => {
    const session = makeSession();
    sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(session);
    sessionHelpers.updateTaxQuestionnaireSession.mockResolvedValue(false);
    const callGemini = vi.fn(async () => null);

    const { handleAgentMessage } = await import('../agent-brain');
    const resp = await handleAgentMessage(makeReq('cancel') as any, makeCtx(callGemini) as any);

    expect(resp.data.message).toBe('Session was modified by another process. Please try again.');
    expect(sessionHelpers.updateTaxQuestionnaireSession).toHaveBeenCalledTimes(1);
    expect(callGemini).not.toHaveBeenCalled();
  });
});
