import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const startReview = vi.fn();
const answerReviewMessage = vi.fn();
const hasConfirmedFreshReview = vi.fn();
const getActiveReviewForTenant = vi.fn();
const applyFieldEdit = vi.fn();
const confirmAndSubmit = vi.fn();

vi.mock('../tax-review-agent.js', () => ({
  startReview: (...a: any[]) => startReview(...a),
  answerReviewMessage: (...a: any[]) => answerReviewMessage(...a),
  hasConfirmedFreshReview: (...a: any[]) => hasConfirmedFreshReview(...a),
  getActiveReviewForTenant: (...a: any[]) => getActiveReviewForTenant(...a),
  applyFieldEdit: (...a: any[]) => applyFieldEdit(...a),
  confirmAndSubmit: (...a: any[]) => confirmAndSubmit(...a),
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

  it('GET /tax-filing/:year/review/status returns confirmedAndFresh', async () => {
    hasConfirmedFreshReview.mockResolvedValue(true);
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/2025/review/status').set('x-tenant-id', 't1');
    expect(res.body.data.confirmedAndFresh).toBe(true);
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
});
