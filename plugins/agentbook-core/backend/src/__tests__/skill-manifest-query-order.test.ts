import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * Launch-gap PR-5, G-5C: AbSkillManifest.findMany() must request a
 * deterministic row order (`orderBy: { name: 'asc' }`) — without it, which
 * of two colliding skills' array position comes first depends on undefined
 * DB row order. This doesn't make the routing OUTCOME correct by itself
 * (see skill-routing-canonical.test.ts and CREATE_INVOICE_TRIGGER_PATTERN's
 * comment in skill-routing.ts for the actual correctness fix) — it only
 * guarantees production's row order matches whatever this plan fixed it to,
 * rather than depending on Postgres internals.
 */

const skillManifestFindMany = vi.fn(async () => []);

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: skillManifestFindMany },
    abConvThread: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args) => ({ id: 'thread-1', turns: [], ...args.data })),
    },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

beforeEach(() => {
  skillManifestFindMany.mockClear();
});

describe('AbSkillManifest.findMany — deterministic order (Launch-gap PR-5)', () => {
  it('requests rows ordered by name ascending', async () => {
    const harness = buildTestContext({
      text: 'spent $5 on coffee',
      tenantId: 'tenant-order-check',
      classification: {
        selectedSkill: { name: 'record-expense', endpoint: { method: 'POST', path: '/expenses' } },
        extractedParams: { amountCents: 500 },
        confidence: 0.9,
      },
      skillResponses: { 'POST /expenses': { data: { id: 'exp-1' } } },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(harness.req as any, harness.ctx as any);

    expect(skillManifestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });
});
