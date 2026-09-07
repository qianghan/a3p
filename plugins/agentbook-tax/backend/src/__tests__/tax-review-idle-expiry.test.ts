import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An abandoned tax review captured the entire chat, permanently.
 *
 * ACTIVE_REVIEW_STATUSES is ['summarizing','awaiting_edit'] with no expiry, and
 * the interception in agent-brain runs BEFORE classification on all four
 * surfaces (web, Telegram, WhatsApp, MCP). Reproduced on the US tenant: every
 * message — "paid AWS $1240", "what is my cash balance?", "can I deduct a home
 * office?" — came back as
 *
 *   "I can update a number, answer a question about your filing, or you can
 *    say 'looks good' to submit — what would you like to do?"
 *
 * until I happened to send "cancel". A user who starts a review, gets
 * distracted, and comes back tomorrow to log a coffee finds a product that
 * answers nothing and never says why. The submit gate is a safety property and
 * stays; open-ended CAPTURE of every future message is not.
 *
 * Two independent releases, so one failing does not restore the trap:
 *   1. idle TTL — a review untouched for 30 minutes is no longer "active"
 *   2. transactional fall-through — a message that is plainly an instruction to
 *      the books routes normally even inside a live review
 */

const reviewFindFirst = vi.fn();
const reviewUpdateMany = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFilingReview: {
      findFirst: (...a: unknown[]) => reviewFindFirst(...a),
      updateMany: (...a: unknown[]) => reviewUpdateMany(...a),
    },
  },
}));

const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

beforeEach(() => {
  vi.clearAllMocks();
  reviewUpdateMany.mockResolvedValue({ count: 1 });
});

describe('an idle review stops intercepting', () => {
  it('a review untouched for over 30 minutes is not active', async () => {
    reviewFindFirst.mockResolvedValue({ taxYear: 2025, status: 'awaiting_edit', updatedAt: ago(31 * MIN) });
    const { getActiveReviewForTenant } = await import('../tax-review-agent');
    expect(await getActiveReviewForTenant('t1')).toBeNull();
  });

  it('and is retired, so the next message is not re-checked forever', async () => {
    reviewFindFirst.mockResolvedValue({ taxYear: 2025, status: 'awaiting_edit', updatedAt: ago(31 * MIN) });
    const { getActiveReviewForTenant } = await import('../tax-review-agent');
    await getActiveReviewForTenant('t1');
    expect(reviewUpdateMany, 'stale review left in an active status').toHaveBeenCalled();
    const arg = reviewUpdateMany.mock.calls[0][0];
    expect(arg.data.status).toBe('abandoned');
  });

  it('a review touched a minute ago still intercepts', async () => {
    // The feature has to keep working for someone actually mid-review.
    reviewFindFirst.mockResolvedValue({ taxYear: 2025, status: 'awaiting_edit', updatedAt: ago(1 * MIN) });
    const { getActiveReviewForTenant } = await import('../tax-review-agent');
    expect(await getActiveReviewForTenant('t1')).toEqual({ taxYear: 2025 });
    expect(reviewUpdateMany).not.toHaveBeenCalled();
  });

  it('treats a missing updatedAt as fresh rather than silently dropping a live review', async () => {
    reviewFindFirst.mockResolvedValue({ taxYear: 2025, status: 'awaiting_edit', updatedAt: null });
    const { getActiveReviewForTenant } = await import('../tax-review-agent');
    expect(await getActiveReviewForTenant('t1')).toEqual({ taxYear: 2025 });
  });
});

