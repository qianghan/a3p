import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-gap PR-11, Task 1 — chat/MCP parity for "regenerate a stuck tax
 * draft", mirroring apps/web-next's POST /tax-fast-track/regenerate route's
 * eligibility rules (paid add-on gate, session must be 'completed', draft
 * must be null/'failed'/stale) inside agent-brain.ts's existing Step 1c
 * block (the tax draft/letter status intent), gated on a NEW regenerate-
 * intent regex layered on top of the existing TAX_DRAFT_STATUS_RE gate.
 *
 * Scaffolding mirrors tax-questionnaire-recovery.test.ts's "tax draft status
 * intent (Step 1c)" describe block exactly (same dbMock shape, same partial
 * mock of ../tax-questionnaire-session.js to decouple Step 1b's
 * getActiveTaxQuestionnaireSession from the db mock while keeping the real
 * getLatestTaxQuestionnaireSession/isDraftStale used by Step 1c), plus the
 * @naap/billing hasAddOn mock style from start-tax-fast-track-skill.test.ts.
 *
 * See:
 *   apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const hasAddOnMock = vi.fn(async () => true); // entitled by default
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOnMock(...args) }));

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
  abTaxQuestionnaireSession: { findFirst: vi.fn(async (_args?: any) => null as any) },
  abTaxFastTrackDraft: { findUnique: vi.fn(async () => null as any) },
  $executeRaw: vi.fn(async () => 1),
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

// Decouple Step 1b (AbTaxQuestionnaireSession recovery) from the db mock so
// it never mistakes the 'completed' session these tests configure for an
// active in-progress one — same reasoning as tax-questionnaire-recovery.test.ts.
// getLatestTaxQuestionnaireSession/isDraftStale stay real: they're plain reads
// against the already-mocked db above, exercised directly by Step 1c.
const sessionHelpers = {
  getActiveTaxQuestionnaireSession: vi.fn(async (_tenantId: string) => null as any),
  updateTaxQuestionnaireSession: vi.fn(async (_id: string, _version: number, _data: any) => true),
};
vi.mock('../tax-questionnaire-session.js', async () => {
  const actual = await vi.importActual<typeof import('../tax-questionnaire-session.js')>(
    '../tax-questionnaire-session.js',
  );
  return {
    ...sessionHelpers,
    getLatestTaxQuestionnaireSession: actual.getLatestTaxQuestionnaireSession,
    isDraftStale: actual.isDraftStale,
  };
});

vi.mock('../personal-profile-context.js', () => ({
  buildPersonalProfileContext: vi.fn(async () => ''),
}));
vi.mock('../past-filing-context.js', () => ({
  buildPastFilingContext: vi.fn(async () => ''),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeReq(text: string, tenantId = 'tenant-1') {
  return { text, tenantId, channel: 'web' } as any;
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    callGemini: vi.fn(),
    baseUrls: {},
    classifyAndExecuteV1: vi.fn(async () => null),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  hasAddOnMock.mockResolvedValue(true);
  sessionHelpers.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
  dbMock.abAgentSession.findFirst.mockResolvedValue(null);
  dbMock.abConvThread.findFirst.mockResolvedValue(null);
  dbMock.abPastTaxFiling.findUnique.mockResolvedValue(null);
  dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
  dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue(null);
});

describe('tax draft regenerate — chat/MCP parity (Step 1c)', () => {
  it('triggers regeneration (taxDraftReady + sessionId) when the existing draft has failed', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-1', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date(), errorMsg: 'boom' });
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('please regenerate my tax draft'), makeCtx());

    expect(result.data.taxDraftReady).toBe(true);
    expect(result.data.sessionId).toBe('sess-1');
  });

  it('triggers regeneration when no draft row exists yet', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-2', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue(null);
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('can you redo the filing draft'), makeCtx());

    expect(result.data.taxDraftReady).toBe(true);
    expect(result.data.sessionId).toBe('sess-2');
  });

  it('does NOT regenerate a draft that is already ready — explains instead', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-3', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'ready', updatedAt: new Date() });
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('regenerate my filing draft please'), makeCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/already ready/i);
  });

  it('does NOT regenerate a fresh pending draft — explains instead', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-4', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date() }); // fresh, not stale
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('retry generating my client letter'), makeCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/still generating/i);
  });

  it('rejects with an add-on message when tax_fast_track is not enabled', async () => {
    hasAddOnMock.mockResolvedValue(false);
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-5', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date() });
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('regenerate my tax draft'), makeCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/paid add-on/i);
  });

  it('a plain status question ("how is my filing draft doing") is unaffected — still returns status, not regenerate', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-6', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'ready', updatedAt: new Date(), draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf', draftSummary: null, errorMsg: null,
    });
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('how is my filing draft doing'), makeCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/ready/i);
    expect(result.data.message).toContain('draft.pdf');
  });

  it('does not even check the add-on (or query the draft) when there is no completed questionnaire session at all', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const ctx = makeCtx();

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(makeReq('please regenerate my tax draft'), ctx);

    expect(dbMock.abTaxFastTrackDraft.findUnique).not.toHaveBeenCalled();
    expect(hasAddOnMock).not.toHaveBeenCalled();
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1); // falls through to normal classification
  });
});
