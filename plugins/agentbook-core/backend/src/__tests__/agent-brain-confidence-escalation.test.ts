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

  it('LOW-confidence general-question is answered, not escalated and not executed', async () => {
    // This asserted `executeClassification` HAD been called, because
    // general-question used to be an HTTP skill (POST /ask). That endpoint
    // only ever existed on the dev Express app, so in production the call it
    // pinned always failed. The skill is INTERNAL now: agent-brain answers it
    // in-process with the grounded advisor. The invariant this test exists
    // for is unchanged and still checked — a low-confidence question must not
    // be met with "I'm not entirely sure, proceed?" — it is simply satisfied
    // by answering rather than by executing.
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'something vague',
      tenantId: 'tenant-readonly',
      classification: {
        selectedSkill: {
          name: 'general-question',
          endpoint: { method: 'INTERNAL', url: '' },
          confirmBefore: false,
        },
        extractedParams: { question: 'something vague' },
        confidence: 0.3,
      },
      llmFixtures: [{ response: 'Here is an answer.' }],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const response = await handleAgentMessage(req as any, ctx as any);

    expect(response.success).toBe(true);
    expect(response.data.skillUsed).toBe('general-question');
    expect(response.data.plan?.requiresConfirmation).toBeUndefined();
    expect(response.data.message.toLowerCase()).not.toContain('not entirely sure');
    expect(executeClassification).not.toHaveBeenCalled();
    expect(skillCalls).toHaveLength(0);
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

/**
 * The gap between the two confidence rules.
 *
 * Step 3b escalates below 0.55. Step 4's assessComplexity used to plan below
 * 0.6. A score in [0.55, 0.6) therefore passed the gate, EXECUTED the skill,
 * and was then thrown away for a "Here's my plan / Proceed?" preview whose
 * single step redoes the finished work. Seen in nightly run 34793265788 on a
 * one-word read-only question.
 *
 * query-estimates is used deliberately: it is in none of
 * ESCALATION_EXEMPT_SKILLS / REPORTING_SKILLS / DIRECT_SKILLS, so nothing but
 * the afterExecution flag can keep this green.
 */
describe('a low score never converts an already-executed answer into a plan', () => {
  it('confidence 0.58 executes and answers — no plan preview', async () => {
    const { req, ctx, executeClassification, llmCalls } = buildTestContext({
      text: 'Estimates',
      tenantId: 'tenant-gap',
      classification: {
        selectedSkill: {
          name: 'query-estimates',
          endpoint: { method: 'GET', path: '/estimates' },
          confirmBefore: false,
        },
        extractedParams: {},
        confidence: 0.58, // >= 0.55 (3b lets it through), < 0.6 (Step 4 planned it)
      },
      skillResponses: {
        'GET /estimates': { data: { estimates: [], count: 0 } },
      },
      // If the planner IS reached it will produce a real plan, so the failure
      // mode is the observed one rather than an empty-plan fall-through.
      llmFixtures: [
        {
          systemMatch: 'decompose a user request',
          response: '[{"action":"query-estimates","description":"Retrieve a list of all estimates","params":{},"dependsOn":[],"canUndo":false}]',
        },
      ],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const response = await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).toHaveBeenCalled();
    expect(response.data.skillUsed).toBe('query-estimates');
    expect(response.data.plan).toBeUndefined();
    expect(response.data.message).not.toContain("Here's my plan");
    // The planner LLM must not even be consulted.
    expect(llmCalls.history.some((c) => c.system.toLowerCase().includes('decompose a user request'))).toBe(false);
  });
});
