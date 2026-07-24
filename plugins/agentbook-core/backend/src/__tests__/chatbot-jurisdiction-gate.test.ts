import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch gate — AI chat is US/CA-only. The agent brain has no
 * per-jurisdiction tax/currency logic for AU/UK/NZ yet, so handleAgentMessage
 * short-circuits a non-US/CA tenant with a "use the web app" message BEFORE
 * classification (so no skill runs with US math). Web UI is unaffected —
 * this is chat-only, and applies to every transport that routes through
 * handleAgentMessage (web chat, Telegram, MCP).
 *
 * Scaffolding mirrors bank-connect-redirect.test.ts exactly (same dbMock +
 * partial tax-questionnaire-session mock) so the request passes cleanly
 * through the earlier pipeline steps to reach the gate.
 */

const hasAddOnMock = vi.fn(async () => true);
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOnMock(...args) }));

const dbMock = {
  abConversation: {
    findFirst: vi.fn(async () => null as any),
    findMany: vi.fn(async () => [] as any[]),
    create: vi.fn(async () => ({})),
  },
  abAgentSession: {
    findFirst: vi.fn(async () => null as any),
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

const sessionHelpers = {
  getActiveTaxQuestionnaireSession: vi.fn(async (_tenantId: string) => null as any),
  updateTaxQuestionnaireSession: vi.fn(async (_id: string, _v: number, _d: any) => true),
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
vi.mock('../personal-profile-context.js', () => ({ buildPersonalProfileContext: vi.fn(async () => '') }));
vi.mock('../past-filing-context.js', () => ({ buildPastFilingContext: vi.fn(async () => '') }));

function makeReq(text: string, tenantId = 'tenant-1') {
  return { text, tenantId, channel: 'web' } as any;
}
function skillCtx() {
  return {
    callGemini: vi.fn(),
    baseUrls: {},
    classifyAndExecuteV1: vi.fn(async () => ({
      selectedSkill: { name: 'tax-estimate' }, extractedParams: {}, confidence: 0.9,
      skillUsed: 'tax-estimate',
      skillResponse: { message: 'Your estimated tax is $1,234.' },
      responseData: { message: 'Your estimated tax is $1,234.', skillUsed: 'tax-estimate', confidence: 0.9 },
    })),
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
  dbMock.abTenantConfig.findFirst.mockResolvedValue(null);
});

describe('Chatbot US/CA/AU jurisdiction gate', () => {
  it('does NOT gate an AU tenant — AU is supported, the skill runs', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'au' } as any);
    const ctx = skillCtx();
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq("what's my tax estimate this quarter"), ctx);

    expect(result.data.skillUsed).not.toBe('jurisdiction-gate');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1);
  });

  it('STILL gates a UK tenant (only US/CA/AU supported)', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'uk' } as any);
    const ctx = skillCtx();
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq("what's my tax estimate this quarter"), ctx);

    expect(result.data.skillUsed).toBe('jurisdiction-gate');
    expect(ctx.classifyAndExecuteV1).not.toHaveBeenCalled();
  });

  it('does NOT gate a US tenant — the skill runs', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'us' } as any);
    const ctx = skillCtx();
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq("what's my tax estimate this quarter"), ctx);

    expect(result.data.skillUsed).not.toBe('jurisdiction-gate');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate a CA tenant', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'ca' } as any);
    const ctx = skillCtx();
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq("what's my tax estimate this quarter"), ctx);

    expect(result.data.skillUsed).not.toBe('jurisdiction-gate');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1);
  });

  it('treats an unset jurisdiction (no tenant config) as US — not gated', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue(null as any);
    const ctx = skillCtx();
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq("what's my tax estimate this quarter"), ctx);

    expect(result.data.skillUsed).not.toBe('jurisdiction-gate');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1);
  });
});
