import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cancelling a review must actually EXIT review mode.
 *
 * This was a defect in the plan itself, not just the implementation: the
 * cancel branch set `status: 'summarizing'`, which is one of the two
 * statuses getActiveReviewForTenant() counts as ACTIVE. So the row stayed
 * "in progress" forever, and every later message from that tenant — "record
 * a $40 lunch", "what did I spend on travel?", anything — got swallowed by
 * agent-brain's early-interception block and fed back into the review state
 * machine. Once the ctx wiring reached the real channels there was no way
 * out of review mode short of a successful confirm.
 *
 * The DB mock below APPLIES the `where.status.in` filter rather than
 * resolving a fixed row. That is what makes this test able to fail: the bug
 * IS the status set, so a mock that ignores the filter would happily report
 * "no active review" for a row the real query would have returned.
 */

const filingFindFirst = vi.fn();
const reviewUpdate = vi.fn();
const updateFilingField = vi.fn();
const submitFiling = vi.fn();

/** The one review row this tenant has, mutated by reviewUpdate. */
let reviewRow: { id: string; tenantId: string; taxYear: number; status: string; awaitingFieldId: string | null };

function reviewFindFirst(args: {
  where?: { tenantId?: string; taxYear?: number; status?: { in?: string[] } };
}) {
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
  forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1500000 }, T2125: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  reviewRow = { id: 'r1', tenantId: 't1', taxYear: 2025, status: 'summarizing', awaitingFieldId: null };
  // Mirror the write back onto the row, the way a real update would.
  reviewUpdate.mockImplementation(async (args: any) => {
    Object.assign(reviewRow, args?.data ?? {});
    return reviewRow;
  });
  filingFindFirst.mockResolvedValue(baseFiling);
});

describe('cancelling a review exits review mode', () => {
  it('the cancel branch moves the review to a TERMINAL status, not back to summarizing', async () => {
    const { answerReviewMessage } = await import('../tax-review-agent.js');
    await answerReviewMessage('t1', 2025, 'no, cancel', vi.fn());

    expect(reviewUpdate).toHaveBeenCalledTimes(1);
    const written = reviewUpdate.mock.calls[0][0].data.status;
    expect(written).not.toBe('summarizing');
    expect(written).not.toBe('awaiting_edit');
    expect(written).toBe('cancelled');
  });

  it('after a cancel, an unrelated message is NOT intercepted — getActiveReviewForTenant reports none', async () => {
    const { answerReviewMessage, getActiveReviewForTenant } = await import('../tax-review-agent.js');

    // Before cancelling, the tenant IS mid-review, so a message would be intercepted.
    expect(await getActiveReviewForTenant('t1')).toEqual({ taxYear: 2025 });

    await answerReviewMessage('t1', 2025, 'no, cancel', vi.fn());

    // "record a $40 lunch" must now reach normal classification. The brain
    // decides that by asking exactly this question.
    expect(await getActiveReviewForTenant('t1')).toBeNull();
  });

  it('a cancelled review is not confirmed, so the submit gate still blocks a bare submit', async () => {
    const { answerReviewMessage, hasConfirmedFreshReview } = await import('../tax-review-agent.js');
    await answerReviewMessage('t1', 2025, 'no, cancel', vi.fn());
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
    expect(submitFiling).not.toHaveBeenCalled();
  });
});
