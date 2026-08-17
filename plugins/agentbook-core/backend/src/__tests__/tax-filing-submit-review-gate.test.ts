import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 16 — the submit-review gate.
 *
 * handleTaxFilingSubmit must not call the real submit endpoint until a
 * confirmed, fresh review exists for this exact filing snapshot. This is
 * the defensive fallback for any path that reaches the submit handler
 * without having gone through a review conversation first (the primary
 * confirm->submit handoff happens inside answerReviewMessage() — Task 12 —
 * directly).
 */

// db is untouched on the not-confirmed-and-fresh path, but the
// confirmed-and-fresh path does write an AbConversation row after a
// successful submit — mock it so that write can't hit a real database.
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { create: vi.fn(async () => ({})) },
  },
}));

// Mock fetch globally — this test verifies the gate check happens BEFORE
// the real submit call, source-order matters (see the wiring test).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => vi.clearAllMocks());

describe('tax-filing-submit gate — calls review/status before the real submit endpoint', () => {
  it('when the review is NOT confirmed-and-fresh, calls review/start instead of the real submit endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { confirmedAndFresh: false } }) }) // status check
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { message: 'Here is your summary...' } }) }); // review/start

    const { handleTaxFilingSubmit } = await import('../server.js');
    const result = await handleTaxFilingSubmit({ tenantId: 't1', extractedParams: { taxYear: 2025 } } as any);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('/review/status');
    expect(urls[1]).toContain('/review/start');
    expect(urls.some((u) => u.includes('/submit') && !u.includes('review'))).toBe(false);
    expect(result.responseData.message).toContain('Here is your summary');
  });

  it('when the review IS confirmed-and-fresh, calls the real submit endpoint as before', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { confirmedAndFresh: true } }) })
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { message: 'Filed!' } }) });

    const { handleTaxFilingSubmit } = await import('../server.js');
    const result = await handleTaxFilingSubmit({ tenantId: 't1', extractedParams: { taxYear: 2025 } } as any);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toContain('/submit');
    expect(urls[1]).not.toContain('review');
    expect(result.responseData.message).toContain('Filed!');
  });
});
