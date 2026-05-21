import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * G-OLD-018: corrections should persist to AbUserMemory and adjust future behavior.
 *
 * NOTE (PR 9): kept as .fails — the correction-write path lives in
 * `agent-memory.handleCorrection` which talks to the DB directly. A proper
 * unit test requires mocking `db.abUserMemory` round-trip. We deferred that
 * to a later PR (see G-014 "no agent-brain integration tests" in the gap
 * report). This test documents the invariant for that future work.
 */

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'sess-1', version: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

describe('agent-memory correction flow', () => {
  it.fails('writes a correction memory entry when user says "no, that should be X"', async () => {
    const harness = buildTestContext({
      text: 'no, that lunch should be marketing not meals',
      feedback: 'no, that lunch should be marketing not meals',
      llmFixtures: [
        { userMatch: 'meal', response: JSON.stringify({ category: 'meals' }) },
      ],
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(harness.req as any, harness.ctx as any);

    // The full correction-write assertion requires intercepting
    // db.abUserMemory.create — which we haven't wired here. Marked .fails
    // until G-014 lands the full integration harness.
    const memCreate = (await import('../db/client.js')).db.abUserMemory.create as any;
    expect(memCreate).toHaveBeenCalled();
    const created = memCreate.mock.calls[0]?.[0]?.data;
    const memStr = JSON.stringify(created || {}).toLowerCase();
    expect(memStr).toMatch(/marketing|meal/);
  });
});
