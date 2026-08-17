import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * buildTaxReviewCtx() — the shared source of ctx.checkActiveTaxReview /
 * ctx.answerTaxReview for all four agent-brain ctx sites (this file's dev
 * Express route plus apps/web-next's web-chat, Telegram and WhatsApp
 * routes).
 *
 * The per-site wiring is guarded in
 * apps/web-next/src/__tests__/api/v1/agentbook-core/tax-review-ctx-wiring.test.ts.
 * This covers what the functions themselves do.
 */

vi.mock('../db/client.js', () => ({
  db: { abConversation: { create: vi.fn(async () => ({})) } },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => vi.clearAllMocks());

const BASE = { '/api/v1/agentbook-tax': 'https://tax.example' };

describe('buildTaxReviewCtx', () => {
  it('returns exactly the two ctx functions, so spreading it wires both', async () => {
    const { buildTaxReviewCtx } = await import('../server.js');
    expect(Object.keys(buildTaxReviewCtx(BASE)).sort()).toEqual([
      'answerTaxReview',
      'checkActiveTaxReview',
    ]);
  });

  it('checkActiveTaxReview reads review/active off the tax base URL and unwraps .data', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ success: true, data: { active: true, taxYear: 2025 } }),
    });
    const { buildTaxReviewCtx } = await import('../server.js');
    const ctx = buildTaxReviewCtx(BASE);

    await expect(ctx.checkActiveTaxReview('t1')).resolves.toEqual({ active: true, taxYear: 2025 });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://tax.example/api/v1/agentbook-tax/tax-filing/review/active',
    );
    expect((fetchMock.mock.calls[0][1] as any).headers['x-tenant-id']).toBe('t1');
  });

  it('answerTaxReview POSTs the user text to that year\'s review/message', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ success: true, data: { message: 'Updated to $80,000.' } }),
    });
    const { buildTaxReviewCtx } = await import('../server.js');
    const ctx = buildTaxReviewCtx(BASE);

    await expect(ctx.answerTaxReview('t1', 2025, 'make it 80000')).resolves.toEqual({
      message: 'Updated to $80,000.',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(String(url)).toBe('https://tax.example/api/v1/agentbook-tax/tax-filing/2025/review/message');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'make it 80000' });
  });

  it('checkActiveTaxReview cannot take chat down: a non-JSON reply means "no active review"', async () => {
    // This function runs on EVERY inbound message. A deployment-protection
    // interstitial, a 502 or a 404 all answer with HTML, so res.json()
    // throws — and an unguarded throw here would break every chat turn for
    // every tenant, not just tax ones. Failing open costs an interception;
    // the submit gate independently protects the money path.
    fetchMock.mockResolvedValueOnce({
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
    });
    const { buildTaxReviewCtx } = await import('../server.js');
    await expect(buildTaxReviewCtx(BASE).checkActiveTaxReview('t1')).resolves.toEqual({ active: false });
  });

  it('checkActiveTaxReview treats a network failure as "no active review" too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { buildTaxReviewCtx } = await import('../server.js');
    await expect(buildTaxReviewCtx(BASE).checkActiveTaxReview('t1')).resolves.toEqual({ active: false });
  });

  it('answerTaxReview returns an honest message rather than throwing when the call fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { buildTaxReviewCtx } = await import('../server.js');
    const result = await buildTaxReviewCtx(BASE).answerTaxReview('t1', 2025, 'looks good');
    expect(result.message).toMatch(/nothing was submitted/i);
  });

  it('falls back to the resolved tax base URL when no baseUrls map is given', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true, data: { active: false } }) });
    const { buildTaxReviewCtx } = await import('../server.js');
    await buildTaxReviewCtx().checkActiveTaxReview('t1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/agentbook-tax/tax-filing/review/active');
  });
});
