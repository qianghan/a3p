import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The review gate must not be bypassable, and a FAILED submit must not
 * leave a review marked confirmed.
 *
 * Two defects, both on the money path:
 *
 *   1. applyFieldEdit / confirmAndSubmit proceeded even when no active
 *      review row existed for the tenant. The `if (review)` guard only
 *      skipped the bookkeeping — the field write and the real submitFiling()
 *      call happened anyway. So POSTing .../review/confirm directly filed a
 *      return that had never been reviewed, which is precisely what the gate
 *      exists to prevent.
 *
 *   2. confirmAndSubmit wrote status:'confirmed' + reviewedFormsHash BEFORE
 *      calling submitFiling(), with no rollback. When submission failed
 *      (validation errors, no partner, network), the review was left marked
 *      confirmed-and-fresh — so hasConfirmedFreshReview() then reported true
 *      and the NEXT submit attempt sailed straight past the gate without any
 *      review having been completed.
 *
 * The review mock applies `where.status.in`, because "is there an ACTIVE
 * review" is exactly the question at issue.
 */

const filingFindFirst = vi.fn();
const reviewUpdate = vi.fn();
const updateFilingField = vi.fn();
const submitFiling = vi.fn();

let reviewRow: { id: string; tenantId: string; taxYear: number; status: string; awaitingFieldId: string | null; reviewedFormsHash?: string | null; confirmedAt?: Date | null } | null = null;

function reviewFindFirst(args: { where?: { tenantId?: string; taxYear?: number; status?: { in?: string[] } } }) {
  if (!reviewRow) return null;
  const where = args?.where ?? {};
  if (where.tenantId && where.tenantId !== reviewRow.tenantId) return null;
  if (where.taxYear !== undefined && where.taxYear !== reviewRow.taxYear) return null;
  if (where.status?.in && !where.status.in.includes(reviewRow.status)) return null;
  return reviewRow;
}

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: {
      findFirst: (...a: any[]) => reviewFindFirst(a[0]),
      update: (...a: any[]) => reviewUpdate(...a),
      upsert: vi.fn(),
    },
    abTenantConfig: { findFirst: vi.fn() },
  },
}));
vi.mock('../tax-filing.js', () => ({ updateFilingField: (...a: any[]) => updateFilingField(...a) }));
vi.mock('../tax-efiling.js', () => ({ submitFiling: (...a: any[]) => submitFiling(...a) }));

const baseFiling = {
  id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
  forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1639206 }, T2125: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  reviewRow = { id: 'r1', tenantId: 't1', taxYear: 2025, status: 'summarizing', awaitingFieldId: null, reviewedFormsHash: null, confirmedAt: null };
  reviewUpdate.mockImplementation(async (args: any) => {
    if (reviewRow) Object.assign(reviewRow, args?.data ?? {});
    return reviewRow;
  });
  filingFindFirst.mockResolvedValue(baseFiling);
  updateFilingField.mockResolvedValue({ updated: true });
});

describe('the review gate is not bypassable', () => {
  it('confirmAndSubmit refuses to submit when no review row exists at all', async () => {
    reviewRow = null;
    const { confirmAndSubmit } = await import('../tax-review-agent.js');

    await expect(confirmAndSubmit('t1', 2025)).rejects.toThrow(/no active review/i);
    expect(submitFiling).not.toHaveBeenCalled();
  });

  it('confirmAndSubmit refuses to submit when the only review was cancelled', async () => {
    reviewRow!.status = 'cancelled';
    const { confirmAndSubmit } = await import('../tax-review-agent.js');

    await expect(confirmAndSubmit('t1', 2025)).rejects.toThrow(/no active review/i);
    expect(submitFiling).not.toHaveBeenCalled();
  });

  it('applyFieldEdit refuses to write a field when no active review exists', async () => {
    reviewRow = null;
    const { applyFieldEdit } = await import('../tax-review-agent.js');

    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', 8000000)).rejects.toThrow(/no active review/i);
    expect(updateFilingField).not.toHaveBeenCalled();
  });

  it('answerReviewMessage refuses a cancelled review rather than resurrecting it', async () => {
    reviewRow!.status = 'cancelled';
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    await expect(answerReviewMessage('t1', 2025, 'looks good', vi.fn())).rejects.toThrow(/no active review/i);
    expect(submitFiling).not.toHaveBeenCalled();
  });

  it('the refusal is a typed NoActiveReviewError, so HTTP routes can answer 409 instead of 500', async () => {
    reviewRow = null;
    const { confirmAndSubmit, NoActiveReviewError } = await import('../tax-review-agent.js');
    await expect(confirmAndSubmit('t1', 2025)).rejects.toBeInstanceOf(NoActiveReviewError);
  });
});

/**
 * The web review tab used to POST review/start on every mount, which burned a
 * Gemini call each time AND upserted the row back to 'summarizing' with
 * confirmedAt/reviewedFormsHash cleared — silently un-confirming an approved
 * review. getReviewState() is the side-effect-free read that mount wanted.
 */
describe('getReviewState is read-only', () => {
  it('reports an in-progress review with its stored summary, writing nothing', async () => {
    reviewRow!.status = 'summarizing';
    (reviewRow as any).summaryText = 'Your taxable income is $73,000.';
    const { getReviewState } = await import('../tax-review-agent.js');

    const state = await getReviewState('t1', 2025);

    expect(state.active).toBe(true);
    expect(state.confirmedAndFresh).toBe(false);
    expect(state.summaryText).toBe('Your taxable income is $73,000.');
    expect(state.criticalFields.length).toBeGreaterThan(0);
    expect(state.computedTotals.taxPayableCents).toBe(1639206);
    expect(reviewUpdate).not.toHaveBeenCalled();
  });

  it('reports confirmedAndFresh for a confirmed review whose forms have not changed', async () => {
    const { getReviewState, confirmAndSubmit } = await import('../tax-review-agent.js');
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Filed!', filed: false } });
    await confirmAndSubmit('t1', 2025);

    const state = await getReviewState('t1', 2025);
    expect(state.status).toBe('confirmed');
    expect(state.active).toBe(false);
    expect(state.confirmedAndFresh).toBe(true);
  });

  it('reports nothing (rather than throwing) when the tenant has no review at all', async () => {
    reviewRow = null;
    const { getReviewState } = await import('../tax-review-agent.js');
    const state = await getReviewState('t1', 2025);
    expect(state).toMatchObject({ status: null, active: false, confirmedAndFresh: false, summaryText: null });
    expect(reviewUpdate).not.toHaveBeenCalled();
  });
});

/**
 * The chat path validated money through parseMoneyInputCents (rejects
 * negatives, caps at $10,000,000); the structured web edit-field route only
 * checked Number.isInteger. Same field, same money, two different rule sets —
 * so -$500 and $99,999,999 went in from the web tab and bounced from chat.
 * applyFieldEdit is the ONE shared executor both paths call, so the rule
 * lives there and neither caller can be missing it.
 */
describe('money bounds live in the shared executor', () => {
  it('rejects a negative amount', async () => {
    const { applyFieldEdit } = await import('../tax-review-agent.js');
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', -50000)).rejects.toThrow(/invalid amount/i);
    expect(updateFilingField).not.toHaveBeenCalled();
  });

  it('rejects an amount over $10,000,000', async () => {
    const { applyFieldEdit, MAX_MONEY_CENTS } = await import('../tax-review-agent.js');
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', MAX_MONEY_CENTS + 1)).rejects.toThrow(/invalid amount/i);
    expect(updateFilingField).not.toHaveBeenCalled();
  });

  it('rejects a non-integer cent value', async () => {
    const { applyFieldEdit } = await import('../tax-review-agent.js');
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', 1234.56)).rejects.toThrow(/invalid amount/i);
    expect(updateFilingField).not.toHaveBeenCalled();
  });

  it('accepts a valid amount, including exactly the cap and zero', async () => {
    const { applyFieldEdit, MAX_MONEY_CENTS } = await import('../tax-review-agent.js');
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', 0)).resolves.toBeTruthy();
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', MAX_MONEY_CENTS)).resolves.toBeTruthy();
  });

  it('the rejection is a typed InvalidMoneyValueError, so routes can answer 400', async () => {
    const { applyFieldEdit, InvalidMoneyValueError } = await import('../tax-review-agent.js');
    await expect(applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', -1)).rejects.toBeInstanceOf(InvalidMoneyValueError);
  });
});

describe('a failed submit does not leave the review marked confirmed', () => {
  it('confirmAndSubmit writes confirmed/reviewedFormsHash only AFTER submitFiling succeeds', async () => {
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Filed!', filed: false } });
    const { confirmAndSubmit } = await import('../tax-review-agent.js');

    const result = await confirmAndSubmit('t1', 2025);

    expect(result.message).toContain('Filed!');
    expect(reviewRow!.status).toBe('confirmed');
    expect(reviewRow!.reviewedFormsHash).toBeTruthy();
  });

  it('when submitFiling fails, the review stays un-confirmed and the gate still blocks the next attempt', async () => {
    submitFiling.mockResolvedValue({ success: false, error: 'Cannot file — 2 validation error(s)' });
    const { confirmAndSubmit, hasConfirmedFreshReview } = await import('../tax-review-agent.js');

    const result = await confirmAndSubmit('t1', 2025);

    expect(result.filed).toBe(false);
    expect(result.message).toContain('validation error');
    expect(reviewRow!.status).not.toBe('confirmed');
    expect(reviewRow!.reviewedFormsHash).toBeFalsy();
    // The gate's own question: a failed submit must not open the door.
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });

  it('when submitFiling throws, the review stays un-confirmed', async () => {
    submitFiling.mockRejectedValue(new Error('partner API timeout'));
    const { confirmAndSubmit, hasConfirmedFreshReview } = await import('../tax-review-agent.js');

    await expect(confirmAndSubmit('t1', 2025)).rejects.toThrow('partner API timeout');
    expect(reviewRow!.status).not.toBe('confirmed');
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });
});
