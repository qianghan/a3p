export interface LLMFixture {
  // matches by includes() on system+user — both lowercased and trimmed
  systemMatch?: string;
  userMatch?: string;
  response: string | null;
}

export interface MockLLMCalls {
  callCount: number;
  history: Array<{ system: string; user: string; max?: number }>;
}

/**
 * Builds a mock `callGemini` function suitable for injecting into agent-brain
 * tests. Returns the mock plus a handle to inspect call history.
 *
 * Usage:
 *   const { callGemini, calls } = buildMockGemini([
 *     { userMatch: 'lunch', response: '{"category":"meals","confidence":0.9}' },
 *   ]);
 *   await agentBrain.handle(ctx, 'log $5 lunch', { ...overrides, callGemini });
 *   expect(calls.callCount).toBe(1);
 *
 * If no fixture matches, returns null (matches the production behavior when
 * Gemini is unavailable).
 */
export function buildMockGemini(fixtures: LLMFixture[]): {
  callGemini: (system: string, user: string, max?: number) => Promise<string | null>;
  calls: MockLLMCalls;
} {
  const calls: MockLLMCalls = { callCount: 0, history: [] };
  const callGemini = async (system: string, user: string, max?: number): Promise<string | null> => {
    calls.callCount += 1;
    calls.history.push({ system, user, max });
    const match = fixtures.find((f) => {
      if (f.systemMatch && !system.toLowerCase().includes(f.systemMatch.toLowerCase())) return false;
      if (f.userMatch && !user.toLowerCase().includes(f.userMatch.toLowerCase())) return false;
      return true;
    });
    return match?.response ?? null;
  };
  return { callGemini, calls };
}
