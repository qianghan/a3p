import { describe, it, expect } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * G-OLD-018: corrections should persist to AbUserMemory and adjust future behavior.
 *
 * Tests verify the correction-flow invariant: when user says "no that should be X",
 * a memory entry is written with the correction.
 */
describe('agent-memory correction flow', () => {
  it.fails('writes a correction memory entry when user says "no, that should be X"', async () => {
    const { ctx } = buildTestContext({
      llmFixtures: [
        { userMatch: 'meal', response: JSON.stringify({ category: 'meals' }) },
      ],
      memory: [],
    });

    // TODO: invoke agent-brain with a correction phrase.
    // Concrete assertion: after handling "no, that lunch should be marketing not meals",
    // ctx.memory should contain a new entry recording the correction.
    const handleAgentMessage = await import('../agent-brain').then(
      (m) => m.handleAgentMessage as unknown as
        | undefined
        | ((ctx: unknown, text: string) => Promise<unknown>),
    );
    if (!handleAgentMessage) {
      throw new Error('agent-brain has no testable entry point yet');
    }

    await handleAgentMessage(ctx, 'no, that lunch should be marketing not meals');

    expect(ctx.memory.length).toBeGreaterThan(0);
    const memoryStr = JSON.stringify(ctx.memory).toLowerCase();
    expect(memoryStr).toMatch(/marketing|meal/);
  });
});
