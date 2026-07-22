import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * French UI Phase 1 (AU-1 plan appendix, Task 12, Step 5).
 *
 * When a tenant's AbTenantConfig.locale is French (any 'fr'-prefixed BCP-47
 * tag, e.g. 'fr-CA'), the Gemini system prompt used by the brain's
 * accountant-fallback path should carry a one-line "Respond in French."
 * instruction. Every other locale (including unset) must see a
 * byte-identical prompt to before this feature existed — this test only
 * mocks the Gemini call and inspects the system-prompt string passed to it;
 * it does not (and should not) assert on real French output text, which is
 * a manual verification step per the plan.
 */

const mockState: { tenantConfig: { locale?: string | null; jurisdiction?: string } | null } = {
  tenantConfig: null,
};

vi.mock('../db/client.js', () => {
  return {
    db: {
      abConversation: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
      abConvThread: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: any) => ({
          id: 'thread-1', lastActiveAt: new Date(), turns: [], activeEntities: [], parkedFills: [],
          ...args.data,
        })),
        update: vi.fn(async () => ({})),
      },
      abAgentSession: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: any) => ({ ...args.data, id: 'sess-new', version: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTaxQuestionnaireSession: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTenantConfig: { findFirst: vi.fn(async () => mockState.tenantConfig) },
      abUserMemory: { findMany: vi.fn(async () => []) },
      abSkillManifest: { findMany: vi.fn(async () => []) },
      abEvent: { create: vi.fn(async () => ({})) },
      $executeRaw: vi.fn(async () => 1),
    },
  };
});

beforeEach(() => {
  mockState.tenantConfig = null;
  vi.clearAllMocks();
});

// No skills/classification configured — classifyOnly resolves to null,
// which drives handleAgentMessage down the brainAccountantFallback path
// that assembles the system prompt under test.
describe('French UI Phase 1 — chat system-prompt locale instruction', () => {
  it('includes "Respond in French." when tenant locale is fr-CA', async () => {
    mockState.tenantConfig = { locale: 'fr-CA', jurisdiction: 'ca' };

    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: 'tenant-fr',
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(llmCalls.callCount).toBeGreaterThan(0);
    expect(llmCalls.history[0].system).toContain('Respond in French.');
  });

  it('includes the instruction for a plain "fr" locale tag too', async () => {
    mockState.tenantConfig = { locale: 'fr', jurisdiction: 'ca' };

    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: 'tenant-fr-plain',
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(llmCalls.history[0].system).toContain('Respond in French.');
  });

  it('omits the instruction when tenant locale is en-US', async () => {
    mockState.tenantConfig = { locale: 'en-US', jurisdiction: 'us' };

    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: 'tenant-en',
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(llmCalls.history[0].system).not.toContain('Respond in French.');
  });

  it('omits the instruction when tenant locale is en-CA (English-speaking Canada)', async () => {
    mockState.tenantConfig = { locale: 'en-CA', jurisdiction: 'ca' };

    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: 'tenant-en-ca',
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(llmCalls.history[0].system).not.toContain('Respond in French.');
  });

  it('omits the instruction when there is no tenant config at all (byte-identical to pre-feature behavior)', async () => {
    mockState.tenantConfig = null;

    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: 'tenant-none',
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(llmCalls.history[0].system).not.toContain('Respond in French.');
  });
});
