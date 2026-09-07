import { describe, it, expect, vi } from 'vitest';
import { isReviewInterceptable } from '../review-interception';

// The escape test proceeds PAST interception into the full pipeline, which
// touches Prisma; the intercept test returns early and would not need this.
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => ({ jurisdiction: 'us', locale: 'en-US' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abAdvisorPersona: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    abConvThread: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ id: 'th', turns: [], ...a.data })), update: vi.fn(async () => ({})) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));


/**
 * The second release valve for the review hijack (the first is the idle TTL in
 * the tax plugin). Reproduced on the US tenant: while a review was active,
 * "paid AWS $1240 for hosting" and "what is my cash balance?" were both
 * answered with "I can update a number, answer a question about your filing…".
 */
describe('a plain instruction to the books is not a review answer', () => {
  it.each([
    'paid AWS $1240 for hosting',
    'spent $42 on lunch',
    'invoice Acme $500 for consulting',
    '记录 42 元咖啡',
    'log $14 parking',
  ])('falls through: %s', (text) => {
    expect(isReviewInterceptable(text), `captured a booking instruction: ${text}`).toBe(false);
  });

  it.each([
    'looks good',
    'change line 9 to 4200',
    'why is my deduction so low?',
    'cancel',
    '2400',
  ])('still intercepts a real review reply: %s', (text) => {
    expect(isReviewInterceptable(text), `let a review reply escape: ${text}`).toBe(true);
  });
});

describe('agent-brain actually applies it', () => {
  /**
   * Mutation testing caught this: replacing the call with `&& true` in
   * agent-brain failed nothing, because every test above calls the predicate
   * directly. A predicate nobody consults is a predicate that fixes nothing —
   * the shape of #444 (a reconciled skill array never handed to the
   * classifier), #451 (a message helper server.ts never called) and #453.
   */
  it('a booking instruction reaches the classifier even with a live review', async () => {
    const { buildTestContext } = await import('./helpers/test-context');
    const harness = buildTestContext({
      text: 'paid AWS $1240 for hosting',
      tenantId: 't-review',
      classification: {
        selectedSkill: { name: 'record-expense', endpoint: { method: 'POST', path: '/expenses' } },
        extractedParams: { amountCents: 124000 },
        confidence: 0.9,
      },
      skillResponses: { 'POST /expenses': { data: { id: 'exp-1' } } },
    });
    const answerTaxReview = vi.fn(async () => ({ message: 'review reply' }));
    const ctx = {
      ...harness.ctx,
      checkActiveTaxReview: async () => ({ active: true, taxYear: 2025 }),
      answerTaxReview,
    };
    const { handleAgentMessage } = await import('../agent-brain');
    const res: any = await handleAgentMessage(harness.req as any, ctx as any);
    expect(answerTaxReview, 'the review captured a booking instruction').not.toHaveBeenCalled();
    expect(res?.data?.skillUsed ?? res?.skillUsed).not.toBe('tax-review-agent');
  });

  it('a real review reply is still intercepted', async () => {
    const { buildTestContext } = await import('./helpers/test-context');
    const harness = buildTestContext({ text: 'looks good', tenantId: 't-review' });
    const answerTaxReview = vi.fn(async () => ({ message: 'Submitting your filing…' }));
    const ctx = {
      ...harness.ctx,
      checkActiveTaxReview: async () => ({ active: true, taxYear: 2025 }),
      answerTaxReview,
    };
    const { handleAgentMessage } = await import('../agent-brain');
    const res: any = await handleAgentMessage(harness.req as any, ctx as any);
    expect(answerTaxReview, 'the review stopped working').toHaveBeenCalled();
    expect(res?.data?.skillUsed ?? res?.skillUsed).toBe('tax-review-agent');
  });
});
