import { vi } from 'vitest';
import { buildMockGemini, type LLMFixture } from './mock-llm';

/**
 * Builds a synthetic (req, ctx) pair suitable for agent-brain tests. The
 * shape matches the real `handleAgentMessage(req, ctx)` signature exported
 * from agent-brain.ts.
 *
 * External dependencies are mocked:
 *   - callGemini is built from llmFixtures
 *   - classifyOnly is a vi.fn that returns a configured ClassificationResult
 *   - executeClassification is a vi.fn that records calls (this is the
 *     "did we execute the destructive skill?" signal)
 *   - classifyAndExecuteV1 falls back to running classifyOnly + (if
 *     !confirmBefore) executeClassification — mirrors the real wrapper
 *
 * Test invariants:
 *   - For a destructive skill (confirmBefore: true), executeClassification
 *     should NOT be called before user confirm.
 *   - For a non-destructive skill, executeClassification IS called immediately.
 */
export interface TestSkill {
  name: string;
  endpoint?: { method: string; url?: string; path?: string };
  confirmBefore?: boolean;
  parameters?: Record<string, any>;
  triggerPatterns?: string[];
  category?: string;
  description?: string;
}

export interface TestContextOptions {
  tenantId?: string;
  text?: string;
  channel?: string;
  attachments?: any[];
  sessionAction?: string;
  feedback?: string;
  llmFixtures?: LLMFixture[];
  /**
   * Map of 'METHOD /path' -> response body. executeClassification will look
   * up the selected skill's endpoint here and return the result.
   */
  skillResponses?: Record<string, { status?: number; data?: any; success?: boolean }>;
  /**
   * Optional pre-configured classification result. If set, classifyOnly
   * returns this regardless of input. Use this to simulate "the classifier
   * picked skill X with these params" without coding the regex/LLM paths.
   */
  classification?: {
    selectedSkill: TestSkill;
    extractedParams?: Record<string, any>;
    confidence?: number;
  };
  skills?: TestSkill[];
}

export function buildTestContext(opts: TestContextOptions = {}) {
  const { callGemini, calls: llmCalls } = buildMockGemini(opts.llmFixtures ?? []);
  const skillResponses = opts.skillResponses ?? {};
  const skillCalls: Array<{ method: string; path: string; body?: unknown }> = [];

  // Pure classification: returns a configured ClassificationResult or builds
  // one from the first skill in opts.skills.
  const classifyOnly = vi.fn(async (text: string) => {
    if (opts.classification) {
      const sk = opts.classification.selectedSkill;
      return {
        selectedSkill: sk,
        extractedParams: opts.classification.extractedParams ?? {},
        confidence: opts.classification.confidence ?? 0.9,
        confirmBefore: Boolean(sk.confirmBefore),
        memory: [],
        skills: opts.skills ?? [sk],
        conversation: [],
        tenantConfig: {},
      };
    }
    const sk = opts.skills?.[0];
    if (!sk) return null;
    return {
      selectedSkill: sk,
      extractedParams: {},
      confidence: 0.9,
      confirmBefore: Boolean(sk.confirmBefore),
      memory: [],
      skills: opts.skills ?? [sk],
      conversation: [],
      tenantConfig: {},
    };
  });

  // Execution: records the skill call and returns a configured response.
  const executeClassification = vi.fn(async (classification: any) => {
    const sk = classification?.selectedSkill;
    const ep = sk?.endpoint;
    const method = (ep?.method || 'POST').toUpperCase();
    const path = ep?.path || ep?.url || `/skills/${sk?.name}`;
    skillCalls.push({ method, path, body: classification?.extractedParams });
    const key = `${method} ${path.split('?')[0]}`;
    const matched = skillResponses[key]
      ?? Object.entries(skillResponses).find(([k]) => {
        const [m, p] = k.split(' ');
        return m.toUpperCase() === method && path.startsWith(p);
      })?.[1];
    const data = matched?.data ?? { ok: true };
    return {
      selectedSkill: sk,
      extractedParams: classification?.extractedParams ?? {},
      confidence: classification?.confidence ?? 0.9,
      skillUsed: sk?.name,
      skillResponse: { success: true, data },
      responseData: {
        message: `executed ${sk?.name}`,
        skillUsed: sk?.name,
        confidence: classification?.confidence ?? 0.9,
      },
    };
  });

  // Wrapper that mirrors the real server.ts classifyAndExecuteV1 behavior:
  // classifyOnly + (if !confirmBefore || confirmed) executeClassification.
  const classifyAndExecuteV1 = vi.fn(
    async (text: string, _tenantId: string, _channel: string, _att: any, _mem: any, _sk: any, _conv: any, _tc: any, confirmed?: boolean) => {
      const cls = await classifyOnly(text);
      if (!cls) return null;
      if (cls.confirmBefore && !confirmed) {
        return {
          selectedSkill: cls.selectedSkill,
          extractedParams: cls.extractedParams,
          confidence: cls.confidence,
          confirmBefore: true,
          requiresConfirmation: true,
          skillUsed: cls.selectedSkill.name,
          classification: cls,
        };
      }
      return executeClassification(cls);
    },
  );

  const ctx = {
    skills: opts.skills ?? [],
    callGemini,
    baseUrls: {
      '/api/v1/agentbook-expense': 'http://test-expense',
      '/api/v1/agentbook-core': 'http://test-core',
      '/api/v1/agentbook-invoice': 'http://test-invoice',
      '/api/v1/agentbook-tax': 'http://test-tax',
    },
    classifyAndExecuteV1,
    classifyOnly,
    executeClassification,
  };

  const req = {
    text: opts.text ?? '',
    tenantId: opts.tenantId ?? 'test-tenant',
    channel: opts.channel ?? 'test',
    attachments: opts.attachments,
    sessionAction: opts.sessionAction,
    feedback: opts.feedback,
  };

  return {
    req,
    ctx,
    fetchSkill: executeClassification,
    llmCalls,
    skillCalls,
    classifyOnly,
    executeClassification,
    classifyAndExecuteV1,
  };
}
