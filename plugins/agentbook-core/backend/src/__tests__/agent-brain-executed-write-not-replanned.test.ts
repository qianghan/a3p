import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * A write that already happened is never re-planned.
 *
 * record-expense and create-invoice sit in DESTRUCTIVE_SKILLS but ship with
 * confirmBefore: false, so agent-brain Step 3c EXECUTES them — the POST lands
 * and the expense exists. Step 4 then called assessComplexity again, where the
 * destructive-WORD rule (/\badd\b/, /\brecord\b/, /\bcreate\b/) still matched
 * the very text that produced the write and returned 'complex'. The brain threw
 * the completed result away and returned "Here's my plan: ... Proceed?" —
 * and confirming that plan RE-RUNS the same POST. "add a $40 lunch" booked the
 * expense twice.
 *
 * The invariant: after execution, the response is the executed result. Never a
 * plan whose confirmation would repeat a side effect.
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
        findFirst: vi.fn(async () => null),
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

describe('an executed write is never turned into a "Proceed?" preview', () => {
  it('"add a $40 lunch" records once and answers — no plan to record it again', async () => {
    const { req, ctx, executeClassification, skillCalls, llmCalls } = buildTestContext({
      text: "add a $40 lunch at Joe's",
      tenantId: 'tenant-write',
      classification: {
        selectedSkill: {
          name: 'record-expense',
          endpoint: { method: 'POST', path: '/expenses' },
          confirmBefore: false, // the shipped manifest value — this is why 3c executes
        },
        extractedParams: { amountCents: 4000, vendor: "Joe's" },
        confidence: 0.9, // well clear of every confidence gate
      },
      skillResponses: {
        'POST /expenses': { data: { id: 'exp-new', amountCents: 4000 } },
      },
      // If the planner IS reached it returns a real plan, so the failure mode
      // is the production one (a preview) rather than an empty-plan fallthrough.
      llmFixtures: [
        {
          systemMatch: 'decompose a user request',
          response: '[{"action":"record-expense","description":"Record a $40 lunch expense","params":{"amountCents":4000},"dependsOn":[],"canUndo":true}]',
        },
      ],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    // The money invariant: exactly one write, ever.
    expect(executeClassification).toHaveBeenCalledTimes(1);
    expect(skillCalls.filter((c) => c.method === 'POST' && c.path === '/expenses')).toHaveLength(1);

    // The user gets the executed result, not an offer to redo it.
    expect(res.success).toBe(true);
    expect(res.data.skillUsed).toBe('record-expense');
    expect(res.data.plan).toBeUndefined();
    expect(res.data.message).not.toContain("Here's my plan");
    expect(res.data.message).toContain('executed record-expense');

    // The planner LLM must not even be consulted.
    expect(llmCalls.history.some((c) => c.system.toLowerCase().includes('decompose a user request'))).toBe(false);
  });
});
