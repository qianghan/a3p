import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The confirm-intent regex is the trigger for a REAL tax filing submission:
 * answerReviewMessage()'s 'confirm' branch calls confirmAndSubmit(), which
 * calls submitFiling(). So every string that must NOT submit gets a test
 * here, asserted the only way that actually proves it — submitFiling was
 * never called.
 *
 * The shipped defect: CONFIRM_RE was tested before CANCEL_RE and carried a
 * bare `correct` alternative, so "No, that's not correct", "Is this
 * correct?", "That number is not correct" and "Can you explain the total
 * before I submit?" all classified as `confirm` and filed the return. A user
 * pushing back on a number, or asking a clarifying question, submitted their
 * taxes.
 */

const filingFindFirst = vi.fn();
const reviewFindFirst = vi.fn();
const reviewUpdate = vi.fn();
const updateFilingField = vi.fn();
const submitFiling = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: { findFirst: (...a: any[]) => reviewFindFirst(...a), update: (...a: any[]) => reviewUpdate(...a), upsert: vi.fn() },
    abTenantConfig: { findFirst: vi.fn() },
  },
}));
vi.mock('../tax-filing.js', () => ({ updateFilingField: (...a: any[]) => updateFilingField(...a) }));
vi.mock('../tax-efiling.js', () => ({ submitFiling: (...a: any[]) => submitFiling(...a) }));

const baseFiling = {
  id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
  forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000 }, T2125: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  filingFindFirst.mockResolvedValue(baseFiling);
  reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
  submitFiling.mockResolvedValue({ success: true, data: { message: 'Filed.' } });
});

// An LLM answer with no dollar figures in it, so the grounding verifier
// passes it through unchanged and the assertions below read the real reply.
const explainer = () => vi.fn().mockResolvedValue('{"explanation": "That line is the sum of your booked income."}');

describe('rejections and questions must never submit a filing', () => {
  const mustNotSubmit = [
    "No, that's not correct",
    'Is this correct?',
    'That number is not correct',
    'Can you explain the total before I submit?',
  ];

  for (const text of mustNotSubmit) {
    it(`"${text}" does not call submitFiling`, async () => {
      const { answerReviewMessage } = await import('../tax-review-agent.js');
      await answerReviewMessage('t1', 2025, text, explainer());

      expect(submitFiling).not.toHaveBeenCalled();
      // ...and it must not have marked the review confirmed either — a
      // confirmed marker is what lets the NEXT submit sail past the gate.
      for (const call of reviewUpdate.mock.calls) {
        expect(call[0].data.status).not.toBe('confirmed');
      }
    });
  }

  it('"No, that\'s not correct" is heard as a rejection, not an approval', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, "No, that's not correct", vi.fn());

    expect(reviewUpdate.mock.calls[0][0].data.status).toBe('cancelled');
    expect(result.message).toMatch(/cancel/i);
  });

  it('"Is this correct?" is answered as a question', async () => {
    const callGemini = explainer();
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'Is this correct?', callGemini);

    expect(callGemini).toHaveBeenCalled();
    expect(result.message).toContain('sum of your booked income');
  });

  it('"Can you explain the total before I submit?" is answered, not acted on — the word "submit" inside a question is not consent', async () => {
    const callGemini = explainer();
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'Can you explain the total before I submit?', callGemini);

    expect(submitFiling).not.toHaveBeenCalled();
    expect(callGemini).toHaveBeenCalled();
    expect(result.message).toContain('sum of your booked income');
  });

  it('"That number is not correct" gets a clarifying reply, and writes nothing', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'That number is not correct', vi.fn());

    expect(updateFilingField).not.toHaveBeenCalled();
    expect(result.message).toMatch(/change|question|looks good/i);
  });
});

describe('genuine affirmations still submit — the happy path survives the narrowing', () => {
  const mustSubmit = [
    'yes, submit it',
    "looks good, that's correct, go ahead",
    'looks good',
    'confirm',
    "yes that's correct",
    'looks correct',
  ];

  for (const text of mustSubmit) {
    it(`"${text}" calls submitFiling and marks the review confirmed`, async () => {
      const { answerReviewMessage } = await import('../tax-review-agent.js');
      await answerReviewMessage('t1', 2025, text, vi.fn());

      expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
      expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'confirmed' }),
      }));
    });
  }
});
