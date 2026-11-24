import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

vi.mock('../db/client.js', () => {
  const session: any = {
    id: 'sess-1',
    version: 1,
    status: 'active',
    plan: [],
    pendingConfirmation: null,
    currentStep: 0,
    stepResults: [],
    undoStack: [],
    trigger: '',
  };
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
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: any) => ({ ...session, ...args.data, id: 'sess-new', version: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTaxQuestionnaireSession: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      abTenantConfig: { findFirst: vi.fn(async () => null) },
      abUserMemory: { findMany: vi.fn(async () => []) },
      abSkillManifest: { findMany: vi.fn(async () => []) },
      abEvent: { create: vi.fn(async () => ({})) },
      $executeRaw: vi.fn(async () => 1),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * PR 3d re-review N3 — an optional client message id on agent/message reaches
 * executeClassification (where pay-bill uses it as the payment key, so a
 * resend of the same send is a replay, not a second payment).
 */
describe('clientMessageId plumbing', () => {
  const run = async (clientMessageId?: string) => {
    const { req, ctx, executeClassification } = buildTestContext({
      text: 'log $5 coffee at starbucks', tenantId: 'tenant-cmid',
      classification: { selectedSkill: { name: 'record-expense', endpoint: { method: 'POST', path: '/expenses' }, confirmBefore: false }, extractedParams: { amountCents: 500 }, confidence: 0.85 },
      skillResponses: { 'POST /expenses': { data: { id: 'exp-new', amountCents: 500 } } },
    });
    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage({ ...(req as any), ...(clientMessageId ? { clientMessageId } : {}) }, ctx as any);
    return executeClassification.mock.calls[0][0];
  };
  it('present → carried on the classification', async () => {
    expect((await run('cmid-1234-abcd')).clientMessageId).toBe('cmid-1234-abcd');
  });
  it('absent → not set', async () => {
    expect((await run()).clientMessageId).toBeUndefined();
  });
});
