import { describe, it, expect } from 'vitest';
import { buildMockGemini } from '../mock-llm';

describe('buildMockGemini', () => {
  it('returns null when no fixture matches', async () => {
    const { callGemini } = buildMockGemini([]);
    const result = await callGemini('sys', 'user');
    expect(result).toBeNull();
  });

  it('matches by userMatch substring', async () => {
    const { callGemini } = buildMockGemini([
      { userMatch: 'coffee', response: 'match-A' },
      { userMatch: 'invoice', response: 'match-B' },
    ]);
    expect(await callGemini('sys', 'log a coffee')).toBe('match-A');
    expect(await callGemini('sys', 'send invoice 123')).toBe('match-B');
    expect(await callGemini('sys', 'unknown')).toBeNull();
  });

  it('matches by systemMatch + userMatch (both required)', async () => {
    const { callGemini } = buildMockGemini([
      { systemMatch: 'classifier', userMatch: 'lunch', response: 'classifier-match' },
    ]);
    expect(await callGemini('classifier prompt', 'lunch')).toBe('classifier-match');
    expect(await callGemini('other prompt', 'lunch')).toBeNull();
  });

  it('records call history', async () => {
    const { callGemini, calls } = buildMockGemini([]);
    await callGemini('sys-1', 'user-1');
    await callGemini('sys-2', 'user-2', 1000);
    expect(calls.callCount).toBe(2);
    expect(calls.history[0]).toEqual({ system: 'sys-1', user: 'user-1', max: undefined });
    expect(calls.history[1]).toEqual({ system: 'sys-2', user: 'user-2', max: 1000 });
  });
});
