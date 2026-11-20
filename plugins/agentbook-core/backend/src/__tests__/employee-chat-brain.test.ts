import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';
import { db } from '../db/client.js';

/**
 * PR 4e (R-EMP-5) — brain-level guarantees for employee chat:
 *  1. update-employee is confirm-before-write (plan card, nothing executed);
 *     the confirm line names the localized market frequency label.
 *  2. A TFN/SIN/SSN typed into chat is refused before classification, the LLM,
 *     sessions or memory see it; AbConversation stores only the redacted text,
 *     and nothing is logged with the value.
 */

// Mock the db module so handleAgentMessage doesn't try to hit a real database.
vi.mock('../db/client.js', () => {
  const session: any = { id: 'sess-1', version: 1, status: 'active', plan: [], pendingConfirmation: null, currentStep: 0, stepResults: [], undoStack: [], trigger: '' };
  return {
    db: {
      abConversation: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
      abConvThread: {
        findFirst: vi.fn(async () => null), // no existing thread — brain creates one
        create: vi.fn(async (args: any) => ({
          id: 'thread-1', lastActiveAt: new Date(), turns: [], activeEntities: [], parkedFills: [],
          ...args.data,
        })),
        update: vi.fn(async () => ({})),
      },
      abAgentSession: {
        findFirst: vi.fn(async () => null), // no active session
        create: vi.fn(async (args: any) => ({ ...session, ...args.data, id: 'sess-new', version: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTaxQuestionnaireSession: {
        findFirst: vi.fn(async () => null), // no active tax-questionnaire session
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTenantConfig: {
        findFirst: vi.fn(async () => null),
      },
      abUserMemory: {
        findMany: vi.fn(async () => []),
      },
      abSkillManifest: {
        findMany: vi.fn(async () => []),
      },
      abEvent: {
        create: vi.fn(async () => ({})),
      },
      $executeRaw: vi.fn(async () => 1),
    },
  };
});


beforeEach(() => { vi.clearAllMocks(); (db.abTenantConfig.findFirst as any).mockResolvedValue(null); });

const updateCls = {
  selectedSkill: { name: 'update-employee', endpoint: { method: 'INTERNAL', url: '' }, confirmBefore: true },
  extractedParams: {}, confidence: 0.9, confirmBefore: true,
};

describe('update-employee confirm gate', () => {
  it('shows a plan card and executes nothing before confirm', async () => {
    (db.abTenantConfig.findFirst as any).mockResolvedValue({ jurisdiction: 'au', locale: 'en-AU' });
    const { req, ctx, executeClassification } = buildTestContext({ text: 'change Jane to fortnightly', tenantId: 't-au', classification: { ...updateCls, tenantConfig: { jurisdiction: 'au' } } as any });
    // Prod's classifyOnly carries the tenant row (incl. jurisdiction); the helper's is {}.
    const orig = (ctx as any).classifyOnly;
    (ctx as any).classifyOnly = vi.fn(async (...a: any[]) => ({ ...(await orig(...a)), tenantConfig: { jurisdiction: 'au' } }));
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(executeClassification).not.toHaveBeenCalled();
    expect(res.data.plan?.requiresConfirmation).toBe(true);
    expect(res.data.message).toContain('Fortnightly');
  });
});

describe('sensitive identifiers typed into chat', () => {
  it.each([
    'my SSN is 123-45-6789',
    "Jane's SIN is 046 454 286",
    'set Jane tfn 123456782',
  ])('%s → refused, never classified, stored redacted', async (text) => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); }));
    const { req, ctx, executeClassification } = buildTestContext({ text, tenantId: 't-1', classification: updateCls as any });
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);
    spies.forEach((s) => s.mockRestore());

    const digits = text.replace(/\D/g, '');
    expect(executeClassification).not.toHaveBeenCalled();
    expect((ctx as any).classifyOnly).not.toHaveBeenCalled?.();
    expect(res.data.skillUsed).toBe('sensitive-refused');
    expect(res.data.message).toContain('profile screen');
    expect(res.data.message.replace(/\D/g, '')).not.toContain(digits);
    const writes = JSON.stringify((db.abConversation.create as any).mock.calls);
    expect(writes).toContain('[redacted]');
    expect(writes.replace(/\D/g, '')).not.toContain(digits);
    expect((db.abAgentSession.create as any)).not.toHaveBeenCalled();
    expect(logs.join(' ').replace(/\D/g, '')).not.toContain(digits);
  });

  it('replies in French for a French message', async () => {
    const { req, ctx } = buildTestContext({ text: "Bonjour, mon numéro d'assurance sociale est 046 454 286, pouvez-vous l'enregistrer s'il vous plaît?", tenantId: 't-1', classification: updateCls as any });
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.message).toContain('confidentialité');
  });
});
