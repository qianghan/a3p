import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const startReview = vi.fn();
const answerReviewMessage = vi.fn();
const getReviewState = vi.fn();
const getActiveReviewForTenant = vi.fn();
const applyFieldEdit = vi.fn();
const confirmAndSubmit = vi.fn();

// The two typed refusals are real classes here rather than stubs, because
// the route's status mapping is `instanceof`-based. They're declared in the
// mock factory (not imported via importActual) so the real module — and its
// Prisma client — is never loaded by this route-level test.
class NoActiveReviewError extends Error {
  constructor(tenantId: string, taxYear: number) {
    super(`No active review for tenant ${tenantId} / year ${taxYear} — start a review before editing or submitting`);
    this.name = 'NoActiveReviewError';
  }
}
class InvalidMoneyValueError extends Error {
  constructor(cents: unknown) {
    super(`Invalid amount: got ${String(cents)}`);
    this.name = 'InvalidMoneyValueError';
  }
}

vi.mock('../tax-review-agent.js', () => ({
  startReview: (...a: any[]) => startReview(...a),
  answerReviewMessage: (...a: any[]) => answerReviewMessage(...a),
  getReviewState: (...a: any[]) => getReviewState(...a),
  getActiveReviewForTenant: (...a: any[]) => getActiveReviewForTenant(...a),
  applyFieldEdit: (...a: any[]) => applyFieldEdit(...a),
  confirmAndSubmit: (...a: any[]) => confirmAndSubmit(...a),
  NoActiveReviewError,
  InvalidMoneyValueError,
}));

beforeEach(() => vi.clearAllMocks());

describe('tax review HTTP routes', () => {
  it('GET /tax-filing/review/active returns active:false when there is no in-progress review', async () => {
    getActiveReviewForTenant.mockResolvedValue(null);
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/review/active').set('x-tenant-id', 't1');
    expect(res.body.data.active).toBe(false);
  });

  it('GET /tax-filing/review/active returns the taxYear when a review is in progress', async () => {
    getActiveReviewForTenant.mockResolvedValue({ taxYear: 2025 });
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/review/active').set('x-tenant-id', 't1');
    expect(res.body.data).toEqual({ active: true, taxYear: 2025 });
  });

  it('POST /tax-filing/:year/review/start returns startReview\'s message', async () => {
    startReview.mockResolvedValue({ message: 'Here is your summary...' });
    const { app } = await import('../server.js');
    const res = await request(app).post('/api/v1/agentbook-tax/tax-filing/2025/review/start').set('x-tenant-id', 't1');
    expect(res.body.data.message).toBe('Here is your summary...');
  });

  it('POST /tax-filing/:year/review/message passes the body text through to answerReviewMessage', async () => {
    answerReviewMessage.mockResolvedValue({ message: 'Updated.' });
    const { app } = await import('../server.js');
    const res = await request(app)
      .post('/api/v1/agentbook-tax/tax-filing/2025/review/message')
      .set('x-tenant-id', 't1')
      .send({ text: 'change income to 80000' });
    expect(answerReviewMessage).toHaveBeenCalledWith('t1', 2025, 'change income to 80000', expect.anything());
    expect(res.body.data.message).toBe('Updated.');
  });

  it('GET /tax-filing/:year/review/status returns confirmedAndFresh — what the submit gate reads', async () => {
    getReviewState.mockResolvedValue({
      status: 'confirmed', active: false, confirmedAndFresh: true,
      summaryText: 'Filed.', criticalFields: [], computedTotals: {},
    });
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/2025/review/status').set('x-tenant-id', 't1');
    expect(res.body.data.confirmedAndFresh).toBe(true);
  });

  it('GET /tax-filing/:year/review/status also returns the stored summary + fields, so the web tab can render without POSTing review/start', async () => {
    getReviewState.mockResolvedValue({
      status: 'summarizing', active: true, confirmedAndFresh: false,
      summaryText: 'Your taxable income is $73,000.',
      criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }],
      computedTotals: { taxableIncomeCents: 7300000 },
    });
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/2025/review/status').set('x-tenant-id', 't1');
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.summaryText).toContain('$73,000');
    expect(res.body.data.criticalFields).toHaveLength(1);
    // Read-only: no review was started as a side effect of asking.
    expect(startReview).not.toHaveBeenCalled();
  });

  it('POST /tax-filing/:year/review/edit-field calls applyFieldEdit directly with the exact field named in the body — no text classification', async () => {
    applyFieldEdit.mockResolvedValue({ message: 'Updated to $80,000.', computedTotals: { taxableIncomeCents: 8000000 } });
    const { app } = await import('../server.js');
    const res = await request(app)
      .post('/api/v1/agentbook-tax/tax-filing/2025/review/edit-field')
      .set('x-tenant-id', 't1')
      .send({ formCode: 'T1', fieldId: 'total_income_15000', valueCents: 8000000 });
    expect(applyFieldEdit).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(res.body.data.message).toContain('$80,000');
  });

  it('POST /tax-filing/:year/review/confirm calls confirmAndSubmit directly, no body required', async () => {
    confirmAndSubmit.mockResolvedValue({ message: 'Filed!', filed: false });
    const { app } = await import('../server.js');
    const res = await request(app).post('/api/v1/agentbook-tax/tax-filing/2025/review/confirm').set('x-tenant-id', 't1');
    expect(confirmAndSubmit).toHaveBeenCalledWith('t1', 2025);
    expect(res.body.data.message).toBe('Filed!');
  });

  it('confirming with no active review answers 409 — a refused request, not a server fault', async () => {
    confirmAndSubmit.mockRejectedValue(new NoActiveReviewError('t1', 2025));
    const { app } = await import('../server.js');
    const res = await request(app).post('/api/v1/agentbook-tax/tax-filing/2025/review/confirm').set('x-tenant-id', 't1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no active review/i);
  });

  it('an out-of-range amount answers 400, and the route forwards the value rather than pre-judging it', async () => {
    // The route used to only check Number.isInteger, so it silently ACCEPTED
    // -$500 and $99,999,999 that the chat path rejected. The bounds now live
    // in applyFieldEdit, the one shared executor.
    applyFieldEdit.mockRejectedValue(new InvalidMoneyValueError(-50000));
    const { app } = await import('../server.js');
    const res = await request(app)
      .post('/api/v1/agentbook-tax/tax-filing/2025/review/edit-field')
      .set('x-tenant-id', 't1')
      .send({ formCode: 'T1', fieldId: 'total_income_15000', valueCents: -50000 });
    expect(applyFieldEdit).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', -50000);
    expect(res.status).toBe(400);
  });
});
