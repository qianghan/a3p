import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * Chat replies follow the USER'S language, not a hardcoded one.
 *
 * This file began as "French UI Phase 1" and asserted the literal string
 * "Respond in French." — the only language rule the chat path had. Every
 * other language fell through to English, which is how a user writing
 * Chinese got one Chinese reply (the model's own default) and then English
 * on the next turn, breaking the thread mid-conversation.
 *
 * The intent survives and is asserted below: a French tenant still gets
 * French. What changed is that it is no longer a special case — the prompt
 * now tells the model to mirror the user and name the tenant's configured
 * language only as the tiebreak for messages too short to detect ("yes",
 * "是的"). So the same rule covers Chinese, Spanish and everything else.
 *
 * Still prompt-level only: this inspects the system string passed to the LLM
 * and deliberately does not assert on real translated output.
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
describe('the chat prompt tells the model to mirror the user\'s language', () => {
  async function systemPromptFor(locale: string | null, jurisdiction = 'us'): Promise<string> {
    mockState.tenantConfig = locale === null ? null : { locale, jurisdiction };
    const { req, ctx, llmCalls } = buildTestContext({
      text: 'asdkjaslkdj nonsense text',
      tenantId: `tenant-${locale ?? 'none'}`,
    });
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);
    expect(llmCalls.callCount).toBeGreaterThan(0);
    return llmCalls.history[0].system;
  }

  it('always instructs the model to answer in the language the user wrote in', async () => {
    // The rule that was missing entirely. Without it the model defaults to
    // English for anything it is not explicitly told about.
    for (const locale of ['en-US', 'fr-CA', 'zh-CN', null]) {
      expect(await systemPromptFor(locale), `locale ${locale}`)
        .toMatch(/same language the user wrote/i);
    }
  });

  it('never lets the model switch language mid-thread', async () => {
    expect(await systemPromptFor('zh-CN')).toMatch(/Never switch language mid-conversation/i);
  });

  it('names the tenant language as the tiebreak for a short message', async () => {
    // "是的" / "ok" carry too little signal to detect; without an anchor the
    // model guesses English and the thread flips.
    expect(await systemPromptFor('zh-CN')).toContain('Chinese');
    expect(await systemPromptFor('es-MX')).toContain('Spanish');
  });

  it('still serves French tenants — the original intent, now not a special case', async () => {
    expect(await systemPromptFor('fr-CA')).toContain('French');
    expect(await systemPromptFor('fr')).toContain('French');
  });

  it('does not name French for an English-speaking Canadian tenant', async () => {
    const prompt = await systemPromptFor('en-CA', 'ca');
    expect(prompt).toContain('English');
    expect(prompt).not.toContain('French');
  });

  it('still carries the mirroring rule when no locale is configured', async () => {
    // No tiebreak language to name, but the instruction that matters remains.
    const prompt = await systemPromptFor(null);
    expect(prompt).toMatch(/same language the user wrote/i);
  });
});
