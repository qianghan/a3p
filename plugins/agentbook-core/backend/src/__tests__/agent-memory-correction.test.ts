import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * G-OLD-018: corrections should persist to AbUserMemory and adjust future behavior.
 *
 * This was previously an `it.fails` placeholder — the correction-write path lived
 * in `agent-memory.handleCorrection`, which needed a DB round-trip nobody had
 * mocked, so the invariant was documented as unmet and deferred to G-014.
 *
 * It is now a real test. Fixing the multi-turn correction money bug (canonical
 * eval run 30578028815) split that function up: parsing moved to
 * agent-corrections.ts, applying the edit moved to the edit-expense executor,
 * and what remains in agent-memory.ts is just the memory write —
 * `learnVendorCategoryCorrection`, which is small enough to assert directly.
 *
 * The invariant that matters: after the user corrects a vendor's category, the
 * NEXT expense from that vendor should not need the same correction.
 */

const TRAVEL_ACCOUNT = { id: 'acct-travel', name: 'Travel', accountType: 'expense', isActive: true };

const threadState: { turns: any[] } = { turns: [] };

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => ({
        id: 'thread-1', lastActiveAt: new Date(), turns: threadState.turns,
        activeEntities: [], parkedFills: [],
      })),
      create: vi.fn(async () => ({ id: 'thread-1', turns: [], activeEntities: [], parkedFills: [] })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'sess-1', version: 1, plan: [], stepResults: [], undoStack: [] })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
    abAccount: {
      findFirst: vi.fn(async ({ where }: any) => {
        const wanted = where?.name?.contains?.toLowerCase?.() ?? '';
        return wanted && 'travel'.includes(wanted) ? TRAVEL_ACCOUNT : null;
      }),
    },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

const RECORD_EXPENSE = {
  name: 'record-expense',
  endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/expenses' },
};
const EDIT_EXPENSE = {
  name: 'edit-expense',
  endpoint: { method: 'PUT', url: '/api/v1/agentbook-expense/expenses/:id' },
  confirmBefore: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // The prior turn: the user recorded a Tim Hortons expense.
  threadState.turns = [
    { role: 'user', text: 'lunch at Tim Hortons today $15', at: new Date().toISOString() },
    { role: 'bot', text: 'Recorded $15.00 lunch [Meals]', at: new Date().toISOString(), intent: 'record-expense' },
  ];
});

describe('agent-memory correction flow', () => {
  it('writes a vendor_category memory entry when the user corrects the category', async () => {
    const { req, ctx } = buildTestContext({
      text: 'no, that should be Travel category not Meals',
      tenantId: 'tenant-maya',
      channel: 'web',
      classification: { selectedSkill: RECORD_EXPENSE, extractedParams: {} },
      skills: [RECORD_EXPENSE, EDIT_EXPENSE],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    const upsert = (await import('../db/client.js')).db.abUserMemory.upsert as any;
    expect(upsert).toHaveBeenCalled();

    const call = upsert.mock.calls[0][0];
    // Keyed by the vendor from the prior turn, valued with the corrected
    // category, and flagged as a user correction so it outranks guesses.
    expect(call.where.tenantId_key.key).toBe('vendor_category:tim hortons');
    expect(call.create.value).toBe('acct-travel');
    expect(call.create.type).toBe('vendor_category');
    expect(call.create.source).toBe('user_corrected');
  });

  it('still works when routed through the Telegram adapter\'s feedback flag', async () => {
    // Telegram detects corrections itself and passes `feedback`. That path must
    // keep working — the fix widened detection to all channels rather than
    // moving it off Telegram.
    const { req, ctx } = buildTestContext({
      text: 'no, that should be Travel category not Meals',
      feedback: 'no, that should be Travel category not Meals',
      tenantId: 'tenant-maya',
      channel: 'telegram',
      classification: { selectedSkill: RECORD_EXPENSE, extractedParams: {} },
      skills: [RECORD_EXPENSE, EDIT_EXPENSE],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);

    expect(res.data?.skillUsed).toBe('edit-expense');
    const upsert = (await import('../db/client.js')).db.abUserMemory.upsert as any;
    expect(upsert).toHaveBeenCalled();
  });

  it('does not write a category memory for an amount-only correction', async () => {
    const { req, ctx } = buildTestContext({
      text: 'actually it was $52',
      tenantId: 'tenant-maya',
      channel: 'web',
      classification: { selectedSkill: RECORD_EXPENSE, extractedParams: { amountCents: 5200 } },
      skills: [RECORD_EXPENSE, EDIT_EXPENSE],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(req as any, ctx as any);

    // Nothing was learned about categories — the amount changed, not the class
    // of spending.
    const upsert = (await import('../db/client.js')).db.abUserMemory.upsert as any;
    expect(upsert).not.toHaveBeenCalled();
  });
});
