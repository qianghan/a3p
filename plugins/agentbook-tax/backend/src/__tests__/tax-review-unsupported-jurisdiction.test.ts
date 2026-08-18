import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A tenant whose jurisdiction has no TaxReviewPack (UK was never built) used
 * to hit a dead end with no exit:
 *
 *   review/status  -> getTaxReviewPack('uk') throws  -> 500
 *   review/start   -> getTaxReviewPack('uk') throws  -> 500
 *   submit gate    -> reads status (fails), POSTs start (fails), and answers
 *                     "Please review your filing before submitting" — forever,
 *                     because no review could ever be created to satisfy it.
 *
 * Every one of these must now answer ONCE, clearly, without throwing, and
 * without leaving an active review row behind that would intercept the
 * tenant's next message into the same broken path.
 */

const filingFindFirst = vi.fn();
const reviewFindFirst = vi.fn();
const reviewUpsert = vi.fn();
const reviewUpdate = vi.fn();
const reviewUpdateMany = vi.fn();
const submitFiling = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: {
      findFirst: (...a: any[]) => reviewFindFirst(...a),
      upsert: (...a: any[]) => reviewUpsert(...a),
      update: (...a: any[]) => reviewUpdate(...a),
      updateMany: (...a: any[]) => reviewUpdateMany(...a),
    },
    abTenantConfig: { findFirst: vi.fn() },
  },
}));
vi.mock('../tax-filing.js', () => ({ updateFilingField: vi.fn() }));
vi.mock('../tax-efiling.js', () => ({ submitFiling: (...a: any[]) => submitFiling(...a) }));

const ukFiling = {
  id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'uk', region: '',
  forms: { SA100: { total_income: 4500000 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  filingFindFirst.mockResolvedValue(ukFiling);
  reviewFindFirst.mockResolvedValue(null);
});

describe('a jurisdiction with no TaxReviewPack', () => {
  it('getReviewState reads it as not reviewable instead of throwing', async () => {
    const { getReviewState } = await import('../tax-review-agent.js');
    const state = await getReviewState('t1', 2025);

    expect(state.reviewSupported).toBe(false);
    expect(state.active).toBe(false);
    expect(state.confirmedAndFresh).toBe(false);
    expect(state.summaryText).toMatch(/isn't available yet/i);
  });

  it('startReview answers once with a clear message and creates NO review row — an active row is what makes the loop inescapable', async () => {
    const { startReview, REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE } = await import('../tax-review-agent.js');
    const callGemini = vi.fn();
    const result = await startReview('t1', 2025, callGemini);

    expect(result.message).toBe(REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE);
    expect(result.criticalFields).toEqual([]);
    expect(reviewUpsert).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled(); // no LLM call for a review that can't happen
  });

  it('the message the tenant gets tells them what to do next, and that nothing was filed', async () => {
    const { REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE } = await import('../tax-review-agent.js');
    expect(REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE).toMatch(/contact support/i);
    expect(REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE).toMatch(/nothing has been submitted/i);
  });

  it('answerReviewMessage answers clearly AND retires a stale active review, so the next message is not intercepted again', async () => {
    // A row left behind by a tenant who got stuck before this guard existed.
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });

    const { answerReviewMessage, REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'looks good, submit it', vi.fn());

    expect(result.message).toBe(REVIEW_UNSUPPORTED_JURISDICTION_MESSAGE);
    expect(submitFiling).not.toHaveBeenCalled();
    expect(reviewUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
  });

  it('still recognises the three jurisdictions that DO have packs', async () => {
    const { isReviewSupportedJurisdiction } = await import('../tax-review-agent.js');
    expect(isReviewSupportedJurisdiction('ca')).toBe(true);
    expect(isReviewSupportedJurisdiction('us')).toBe(true);
    expect(isReviewSupportedJurisdiction('AU')).toBe(true);
    expect(isReviewSupportedJurisdiction('uk')).toBe(false);
    expect(isReviewSupportedJurisdiction(null)).toBe(false);
  });
});
