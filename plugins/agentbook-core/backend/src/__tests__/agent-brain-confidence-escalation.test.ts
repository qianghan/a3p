import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * PR 42 / Tier 1 #3 — confidence-scored escalation.
 *
 * When classifyOnly returns a non-destructive skill with confidence below
 * CONFIDENCE_ESCALATION_THRESHOLD (0.55), agent-brain should NOT execute
 * the skill. Instead it builds a plan preview and stores it as a
 * pendingConfirmation — exactly like the destructive-skill gate (PR 9),
 * but framed as "I'm not sure I understood" so the user clarifies before
 * any side effects land.
 *
 * Exempt skills (general-question, query-*, expense-breakdown, etc.) skip
 * the escalation because they're read-only or already fallbacks.
 */

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

describe('confidence-scored escalation (PR 42 / Tier 1 #3)', () => {
  it('LOW-confidence non-destructive skill DOES NOT execute — preview instead', async () => {
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'maybe log something for $5',
      tenantId: 'tenant-low',
      classification: {
        selectedSkill: {
          name: 'record-expense',
          endpoint: { method: 'POST', path: '/expenses' },
          confirmBefore: false,
        },
        extractedParams: { amountCents: 500 },
        confidence: 0.4, // below 0.55 threshold
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const response = await handleAgentMessage(req as any, ctx as any);

    // Core invariant: no execution before the user confirms.
    expect(executeClassification).not.toHaveBeenCalled();
    expect(skillCalls.some((c) => c.path === '/expenses' && c.method === 'POST')).toBe(false);

    // Response should be a plan preview.
    expect(response.success).toBe(true);
    expect(response.data.plan?.requiresConfirmation).toBe(true);
    // The escalation framing should mention uncertainty.
    expect(response.data.message.toLowerCase()).toContain('not entirely sure');
  });

  it('HIGH-confidence non-destructive skill executes immediately (no regression)', async () => {
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'log $5 coffee at starbucks',
      tenantId: 'tenant-high',
      classification: {
        selectedSkill: {
          name: 'record-expense',
          endpoint: { method: 'POST', path: '/expenses' },
          confirmBefore: false,
        },
        extractedParams: { amountCents: 500 },
        confidence: 0.85,
      },
      skillResponses: {
        'POST /expenses': { data: { id: 'exp-new', amountCents: 500 } },
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalled();
    expect(skillCalls.some((c) => c.path === '/expenses' && c.method === 'POST')).toBe(true);
  });

  it('LOW-confidence read-only skill (general-question) is EXEMPT from escalation', async () => {
    const { req, ctx, executeClassification } = buildTestContext({
      text: 'something vague',
      tenantId: 'tenant-readonly',
      classification: {
        selectedSkill: {
          name: 'general-question',
          endpoint: { method: 'POST', path: '/ask' },
          confirmBefore: false,
        },
        extractedParams: { question: 'something vague' },
        confidence: 0.3,
      },
      skillResponses: {
        'POST /ask': { data: { answer: 'Here is an answer.' } },
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    // general-question is in the exempt set — proceeds without escalation.
    expect(executeClassification).toHaveBeenCalled();
  });

  it('LOW-confidence query-expenses (read-only) is EXEMPT from escalation', async () => {
    const { req, ctx, executeClassification } = buildTestContext({
      text: 'how much did i spend kinda recently',
      tenantId: 'tenant-query',
      classification: {
        selectedSkill: {
          name: 'query-expenses',
          endpoint: { method: 'GET', path: '/expenses/query' },
          confirmBefore: false,
        },
        extractedParams: {},
        confidence: 0.45,
      },
      skillResponses: {
        'GET /expenses/query': { data: { total: 1234, count: 5 } },
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalled();
  });

  it('LOW-confidence destructive skill still preserves the destructive framing', async () => {
    // confirmBefore: true takes precedence — the message should NOT say
    // "I'm not sure" because the gate fires for the destructive reason,
    // not for low confidence. (This is a regression guard.)
    const { req, ctx, executeClassification } = buildTestContext({
      text: 'send invoice maybe',
      tenantId: 'tenant-mixed',
      classification: {
        selectedSkill: {
          name: 'send-invoice',
          endpoint: { method: 'POST', path: '/invoices/:id/send' },
          confirmBefore: true,
        },
        extractedParams: { invoiceId: 'inv-1' },
        confidence: 0.4,
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const response = await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).not.toHaveBeenCalled();
    // Standard destructive framing — not the "not entirely sure" lead.
    expect(response.data.message.toLowerCase()).not.toContain('not entirely sure');
  });
});
