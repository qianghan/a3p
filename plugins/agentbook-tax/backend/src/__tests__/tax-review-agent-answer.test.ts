import { describe, it, expect, vi, beforeEach } from 'vitest';

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

beforeEach(() => vi.clearAllMocks());

describe('answerReviewMessage', () => {
  it('a field-edit reply (naming a critical field + a number) writes the value and recomputes — never guesses at a number the user did not say', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    updateFilingField.mockResolvedValue({ updated: true });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'change total income to 80000', vi.fn());

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
  });

  it('a bare number reply, when a specific field is awaited, is treated as that field\'s new value', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'awaiting_edit', awaitingFieldId: 'T1:total_income_15000' });
    updateFilingField.mockResolvedValue({ updated: true });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, '80000', vi.fn());

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
  });

  it('a question routes to explainFieldPrompt and never writes any field', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    const callGemini = vi.fn().mockResolvedValue('{"explanation": "Your total income is $73,000 because..."}');

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'why is my total income what it is', callGemini);

    expect(updateFilingField).not.toHaveBeenCalled();
    expect(result.message).toContain('$73,000');
  });

  it('a confirm reply calls submitFiling directly and returns its real outcome, in the same turn', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Your return package is finalized and exported.' } });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'looks good, submit it', vi.fn());

    expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
    expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'confirmed' }),
    }));
    expect(result.message).toContain('finalized and exported');
  });

  it('a cancel reply ends the review without calling submitFiling', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'no, cancel', vi.fn());

    expect(submitFiling).not.toHaveBeenCalled();
    expect(result.message).toMatch(/cancel/i);
    // Asserting the reply text alone is what let the never-exits-review-mode
    // defect ship: a cancel that writes 'summarizing' back leaves the review
    // ACTIVE, so the message is a lie. See tax-review-cancel-exits.test.ts.
    expect(reviewUpdate.mock.calls[0][0].data.status).toBe('cancelled');
  });

  it('an unclear reply asks a clarifying question without calling the LLM at all', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    const callGemini = vi.fn();

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'hmm ok', callGemini);

    expect(callGemini).not.toHaveBeenCalled();
    expect(result.message).toMatch(/looks good|change|question/i);
  });
});

describe('hasConfirmedFreshReview', () => {
  it('is false when there is no review row at all', async () => {
    reviewFindFirst.mockResolvedValue(null);
    const { hasConfirmedFreshReview } = await import('../tax-review-agent.js');
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });

  it('is false when the review is confirmed but the forms hash no longer matches (edited since via the old /field endpoint)', async () => {
    filingFindFirst.mockResolvedValue({ ...baseFiling, forms: { T1: { total_income_15000: 9999999 } } });
    reviewFindFirst.mockResolvedValue({ status: 'confirmed', reviewedFormsHash: 'stale-hash-value' });
    const { hasConfirmedFreshReview } = await import('../tax-review-agent.js');
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });
});

describe('applyFieldEdit — the shared executor the web review tab (Task 15) also calls directly, no text classification involved', () => {
  it('writes the field, recomputes totals, and formats the confirmation using the tenant\'s real locale/currency', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    updateFilingField.mockResolvedValue({ updated: true });

    const { applyFieldEdit } = await import('../tax-review-agent.js');
    const result = await applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', 8000000);

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
    expect(result.computedTotals).toBeDefined();
  });
});

describe('confirmAndSubmit — the shared executor the web review tab (Task 15) also calls directly on Submit-button click', () => {
  it('hashes the current forms, marks the review confirmed, and calls submitFiling — same as the chat confirm path', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Your return package is finalized and exported.', filed: false } });

    const { confirmAndSubmit } = await import('../tax-review-agent.js');
    const result = await confirmAndSubmit('t1', 2025);

    expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
    expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) }));
    expect(result.message).toContain('finalized and exported');
    expect(result.filed).toBe(false);
  });
});
