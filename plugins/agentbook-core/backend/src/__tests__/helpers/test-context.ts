import { vi } from 'vitest';
import { buildMockGemini, type LLMFixture } from './mock-llm';

/**
 * Builds a synthetic AgentContext suitable for agent-brain tests. Replaces all
 * external dependencies (DB, HTTP fetch to skills, Gemini) with controllable
 * mocks.
 *
 * The real AgentContext interface lives in agent-brain.ts; this matches its
 * shape minimally for testing.
 */
export interface TestContextOptions {
  tenantId?: string;
  llmFixtures?: LLMFixture[];
  /** Map of skill endpoint -> mock response. Keyed by 'METHOD PATH' (e.g., 'POST /expenses'). */
  skillResponses?: Record<string, { status: number; data: unknown }>;
  /** Pre-loaded conversation context (last 10 turns). */
  conversation?: Array<{ role: 'user' | 'agent'; text: string }>;
  /** Pre-loaded memory entries. */
  memory?: Array<{ key: string; value: unknown; confidence: number }>;
  /** Pre-registered skill manifests. Use BUILT_IN_SKILLS in real tests. */
  skills?: Array<{ name: string; endpoint?: { method: string; path: string }; confirmBefore?: boolean }>;
  /** Tenant config snapshot (e.g., currency, jurisdiction). */
  config?: Record<string, unknown>;
}

export function buildTestContext(opts: TestContextOptions = {}) {
  const { callGemini, calls: llmCalls } = buildMockGemini(opts.llmFixtures ?? []);
  const skillResponses = opts.skillResponses ?? {};
  const skillCalls: Array<{ method: string; path: string; body: unknown }> = [];

  // Mock the inner fetch that classifyAndExecuteV1 makes to plugin endpoints.
  // Real implementation in agent-brain calls fetch() to e.g. http://localhost:4051/expenses.
  // We replace with an in-memory lookup keyed by 'METHOD /path' (path-prefix match).
  const fetchSkill = vi.fn(async (method: string, path: string, body: unknown) => {
    skillCalls.push({ method, path, body });
    const key = `${method.toUpperCase()} ${path.split('?')[0]}`;
    const response = skillResponses[key];
    if (!response) {
      // Match path-prefix (e.g., '/expenses' matches 'POST /expenses/123')
      const prefixKey = Object.keys(skillResponses).find((k) => {
        const [m, p] = k.split(' ');
        return m.toUpperCase() === method.toUpperCase() && path.split('?')[0].startsWith(p);
      });
      if (prefixKey) return skillResponses[prefixKey];
      throw new Error(`mock fetchSkill: no response configured for ${key}`);
    }
    return response;
  });

  return {
    ctx: {
      tenantId: opts.tenantId ?? 'test-tenant',
      callGemini,
      conversation: opts.conversation ?? [],
      memory: opts.memory ?? [],
      skills: opts.skills ?? [],
      config: opts.config ?? {},
      // Add other context properties used by agent-brain as they're discovered
    },
    fetchSkill,
    llmCalls,
    skillCalls,
  };
}
