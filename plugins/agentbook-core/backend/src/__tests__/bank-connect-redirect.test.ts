import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-gap PR-11, Task 2 — friendly chat/MCP redirect for "connect my
 * bank" / "link my bank" / bare "Plaid" mentions. Neither Plaid Link nor
 * Basiq's hosted Consent UI is an interactive browser-only widget/redirect
 * that can run inside a chat transport, so instead of falling through to
 * the generic LLM path (or an unrelated financial-summary fallback),
 * agent-brain.ts's Step 1d intercepts these messages with a static pointer
 * to the real /personal page's "Connect bank" button.
 *
 * AU-1 shipped: AU tenants no longer get a special decline path. Basiq now
 * gives AU tenants real bank-sync at parity with Plaid's US/CA coverage, so
 * this redirect message is identical for every jurisdiction — chat can't
 * drive either provider's hosted consent UI regardless of jurisdiction, so
 * there's no functional reason to say anything different to an AU tenant.
 *
 * Scaffolding mirrors tax-draft-regenerate.test.ts's mocking conventions
 * exactly (same dbMock shape, same partial mock of
 * ../tax-questionnaire-session.js to decouple Step 1b from the db mock),
 * since Step 1d sits just after Step 1c in the same handleAgentMessage
 * pipeline and needs to pass through Steps 0/1/1b/1c untouched to reach it.
 *
 * See: apps/web-next/src/app/(dashboard)/personal/page.tsx ("Connect bank" button)
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const hasAddOnMock = vi.fn(async () => true);
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

// Decouple Step 1b (AbTaxQuestionnaireSession recovery) from the db mock —
// none of these tests are mid-questionnaire, and this keeps Step 1c's own
// getLatestTaxQuestionnaireSession/isDraftStale reads real against dbMock.
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
  dbMock.abTenantConfig.findFirst.mockResolvedValue(null);
});

describe('Bank-connect chat/MCP redirect (Step 1d)', () => {
  it('redirects "connect my bank" to the /personal page and Connect bank button', async () => {
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('can you connect my bank account'), makeCtx());

    expect(result.data.message).toMatch(/personal/i);
    expect(result.data.message).toMatch(/connect bank/i);
    expect(result.data.skillUsed).toBe('bank-connect-redirect');
  });

  it('redirects "link my bank" the same way', async () => {
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('I want to link my bank'), makeCtx());

    expect(result.data.message).toMatch(/personal/i);
    expect(result.data.message).toMatch(/connect bank/i);
  });

  it('redirects a bare mention of Plaid', async () => {
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('how do I set up plaid'), makeCtx());

    expect(result.data.message).toMatch(/personal/i);
    expect(result.data.message).toMatch(/connect bank/i);
  });

  // AU-1 shipped: AU tenants no longer get a special decline path. Basiq now
  // gives AU tenants real bank-sync at parity with Plaid's US/CA coverage,
  // so an AU tenant asking chat to connect a bank gets the exact same
  // redirect message a US/CA tenant gets — no jurisdiction branching left.
  it('an AU tenant gets the IDENTICAL redirect message as a US/CA tenant (no more AU decline)', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'au' } as any);
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('can you connect my bank account'), makeCtx());

    expect(result.data.skillUsed).toBe('bank-connect-redirect');
    expect(result.data.message).toBe(
      "I can't connect a bank account directly in chat — that needs an interactive widget. Open Personal Finance (/personal) in the app and tap \"Connect bank\".",
    );
    expect(result.data.message).not.toMatch(/isn't available for australian/i);
  });

  it('a US tenant (explicit jurisdiction) gets the same redirect message as the AU tenant above', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'us' } as any);
    const { handleAgentMessage } = await import('../agent-brain');

    const result = await handleAgentMessage(makeReq('can you connect my bank account'), makeCtx());

    expect(result.data.skillUsed).toBe('bank-connect-redirect');
    expect(result.data.message).toBe(
      "I can't connect a bank account directly in chat — that needs an interactive widget. Open Personal Finance (/personal) in the app and tap \"Connect bank\".",
    );
  });

  it('does NOT intercept bank-reconciliation questions (existing skill, unrelated)', async () => {
    const ctx = makeCtx({
      classifyAndExecuteV1: vi.fn(async () => ({
        selectedSkill: { name: 'bank-reconciliation' },
        extractedParams: {},
        confidence: 0.9,
        skillUsed: 'bank-reconciliation',
        skillResponse: { message: 'You have 3 unmatched transactions.' },
        responseData: {
          message: 'You have 3 unmatched transactions.',
          skillUsed: 'bank-reconciliation',
          confidence: 0.9,
        },
      })),
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const result = await handleAgentMessage(makeReq('what is my bank reconciliation status'), ctx);

    expect(result.data.message).not.toMatch(/connect bank/i);
    expect(result.data.skillUsed).toBe('bank-reconciliation');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalledTimes(1);
  });
});
