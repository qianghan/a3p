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

/**
 * Round three of the same defect. Reordering CANCEL_RE ahead of CONFIRM_RE
 * fixed "No, that's not correct" and nothing else: CONFIRM_RE still matched
 * `submit`/`proceed` ANYWHERE in a sentence, including inside a negation of
 * it, and CANCEL_RE had no negation coverage at all. So every one of these
 * filed a real return.
 *
 * The fix is structural (NEGATION_RE vetoes confirmation outright), so these
 * tests are written to catch a fix that merely special-cases the seven
 * strings the last review happened to type: the `invented` block below uses
 * different word orders, different filler, and negation words that appear in
 * none of the seven ("cannot", "won't", "nope", "rather not").
 */
describe('a negated confirmation verb must never file a return', () => {
  // The seven strings the third review pass found still submitting.
  const knownBad = [
    "Don't submit",
    "don't submit that",
    "Please don't submit yet",
    "hold on, don't submit",
    "Never mind, don't proceed",
    "That's wrong, don't proceed",
    'I do not want to submit this',
  ];

  // Invented here, not reported by any review — the point is to prove the
  // detector generalises rather than memorising the list above.
  const invented = [
    'no, don\'t submit it',                        // two negations, one of them CANCEL_RE's
    'I would rather not go ahead with this',       // "go ahead" negated; no "submit"/"proceed"
    'cannot submit this yet',                      // negation word absent from all seven
    "won't be submitting, please wait",            // contraction the seven never use
    'nope, submit nothing',                        // slang negation + a decoy "submit"
    'Do not submit',                               // opens with "do" — reads as interrogative
    'submit? absolutely not',                      // negation AFTER the approval verb
    'yes — actually no, do not proceed',           // an approval retracted mid-sentence
  ];

  for (const text of [...knownBad, ...invented]) {
    it(`"${text}" does not file the return`, async () => {
      const { answerReviewMessage } = await import('../tax-review-agent.js');
      const result = await answerReviewMessage('t1', 2025, text, explainer());

      // The assertion that actually proves it: the submit code path was
      // never taken. An intent label can be right while the wiring is wrong.
      expect(submitFiling).not.toHaveBeenCalled();
      // ...and no 'confirmed' marker was written, which is what would let
      // the NEXT submit sail straight past hasConfirmedFreshReview().
      for (const call of reviewUpdate.mock.calls) {
        expect(call[0].data.status).not.toBe('confirmed');
      }
      // The reply is a refusal ack or the re-prompt — never the ✅ filing
      // receipt confirmAndSubmit() returns.
      expect(result.message).not.toContain('✅');
      expect(result.message).toMatch(/cancel|change a number|answer a question/i);
    });
  }

  it('a refusal is heard as a refusal — the review is closed, not left hanging', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, "Please don't submit yet", explainer());

    expect(reviewUpdate.mock.calls[0][0].data.status).toBe('cancelled');
    expect(result.message).toMatch(/cancel/i);
  });

  it('a negated verb the confirm pattern does not know ("file it") still refuses to act', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, "This isn't right, don't file it", explainer());

    expect(submitFiling).not.toHaveBeenCalled();
    expect(updateFilingField).not.toHaveBeenCalled();
    // Falls to the deterministic re-prompt rather than cancel — also safe,
    // because 'unclear' asks again instead of filing.
    expect(result.message).toMatch(/change|question|looks good/i);
  });

  it('"hold on" on its own is a pause, not consent and not a shrug', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'hold on', explainer());

    expect(submitFiling).not.toHaveBeenCalled();
    expect(reviewUpdate.mock.calls[0][0].data.status).toBe('cancelled');
    expect(result.message).toMatch(/cancel/i);
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
    'yes',
    'proceed',
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
