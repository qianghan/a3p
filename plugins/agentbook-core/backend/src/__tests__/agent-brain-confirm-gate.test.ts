import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * G-010: confirm gate — destructive ops must NOT execute before user confirms.
 *
 * PR 8 introduced these tests as .fails (documenting the bug).
 * PR 9 splits classifyAndExecuteV1 → classifyOnly + executeClassification,
 * and routes destructive skills (confirmBefore: true) through a plan-preview
 * step in agent-brain.ts. After PR 9 the tests pass without .fails.
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

// agent-memory uses the same db; same mock applies.
// agent-planner uses db.abAgentSession too — covered above.

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent-brain confirm gate (G-010 — closed by PR 9)', () => {
  it('does NOT call destructive skill endpoint before user confirms plan', async () => {
    const { req, ctx, executeClassification } = buildTestContext({
      text: 'send invoice inv-123',
      tenantId: 'tenant-A',
      classification: {
        selectedSkill: {
          name: 'send-invoice',
          endpoint: { method: 'POST', path: '/invoices/:id/send' },
          confirmBefore: true,
        },
        extractedParams: { invoiceId: 'inv-123' },
        confidence: 0.9,
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const response = await handleAgentMessage(req as any, ctx as any);

    // CORE INVARIANT: no skill execution before confirm.
    expect(executeClassification).not.toHaveBeenCalled();

    // Response should be a plan preview.
    expect(response.success).toBe(true);
    expect(response.data.plan?.requiresConfirmation).toBe(true);
    const msg = response.data.message.toLowerCase();
    expect(msg).toMatch(/proceed|confirm|preview|yes\/no/);
  });

  it('does NOT void invoice before user confirms', async () => {
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'void invoice inv-456',
      tenantId: 'tenant-B',
      classification: {
        selectedSkill: {
          name: 'void-invoice',
          endpoint: { method: 'POST', path: '/invoices/:id/void' },
          confirmBefore: true,
        },
        extractedParams: { invoiceId: 'inv-456' },
        confidence: 0.9,
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).not.toHaveBeenCalled();
    expect(skillCalls.filter((c) => c.path.includes('void')).length).toBe(0);
  });

  it('does NOT submit tax filing before user confirms', async () => {
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'file my 2026 taxes',
      tenantId: 'tenant-C',
      classification: {
        selectedSkill: {
          name: 'tax-filing-submit',
          endpoint: { method: 'POST', path: '/tax-filing/:year/submit' },
          confirmBefore: true,
        },
        extractedParams: { taxYear: 2026 },
        confidence: 0.9,
      },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    expect(executeClassification).not.toHaveBeenCalled();
    expect(skillCalls.filter((c) => c.path.includes('submit')).length).toBe(0);
  });

  it('non-destructive skill DOES execute without confirm', async () => {
    const { req, ctx, executeClassification, skillCalls } = buildTestContext({
      text: 'log $5 coffee',
      tenantId: 'tenant-D',
      classification: {
        selectedSkill: {
          name: 'record-expense',
          endpoint: { method: 'POST', path: '/expenses' },
          confirmBefore: false,
        },
        extractedParams: { amountCents: 500 },
        confidence: 0.9,
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
});
