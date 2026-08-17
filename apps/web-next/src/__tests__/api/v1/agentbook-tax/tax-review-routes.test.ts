/**
 * PRODUCTION SURFACE guard for the Tax Review Agent.
 *
 * The tax plugin's Express server is dev-only. On Vercel every tax
 * endpoint is served by a Next route handler under
 * `app/api/v1/agentbook-tax/...`. The review agent shipped with six
 * Express routes and (originally) zero Next mirrors, which meant the
 * whole feature was unreachable in production while every unit test
 * stayed green — the tests exercised the functions, not the surface.
 *
 * These tests exercise each Next handler end to end with the underlying
 * tax-review-agent module mocked, so they fail if a route file is
 * deleted, renamed, or stops delegating to the right function.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const getActiveReviewForTenant = vi.fn();
const startReview = vi.fn();
const answerReviewMessage = vi.fn();
const hasConfirmedFreshReview = vi.fn();
const applyFieldEdit = vi.fn();
const confirmAndSubmit = vi.fn();

vi.mock('@agentbook-tax/tax-review-agent', () => ({
  getActiveReviewForTenant: (...a: unknown[]) => getActiveReviewForTenant(...a),
  startReview: (...a: unknown[]) => startReview(...a),
  answerReviewMessage: (...a: unknown[]) => answerReviewMessage(...a),
  hasConfirmedFreshReview: (...a: unknown[]) => hasConfirmedFreshReview(...a),
  applyFieldEdit: (...a: unknown[]) => applyFieldEdit(...a),
  confirmAndSubmit: (...a: unknown[]) => confirmAndSubmit(...a),
}));

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-1' })),
}));

beforeEach(() => vi.clearAllMocks());

const YEAR = { params: Promise.resolve({ year: '2025' }) };

function post(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

describe('agentbook-tax review routes — production Next surface', () => {
  it('GET review/active reports the tenant\'s in-progress review', async () => {
    getActiveReviewForTenant.mockResolvedValue({ taxYear: 2025 });
    const { GET } = await import('@/app/api/v1/agentbook-tax/tax-filing/review/active/route');
    const res = await GET(new NextRequest('http://localhost/api/v1/agentbook-tax/tax-filing/review/active'));
    expect(await res.json()).toEqual({ success: true, data: { active: true, taxYear: 2025 } });
    expect(getActiveReviewForTenant).toHaveBeenCalledWith('tenant-1');
  });

  it('GET review/active reports active:false when there is none', async () => {
    getActiveReviewForTenant.mockResolvedValue(null);
    const { GET } = await import('@/app/api/v1/agentbook-tax/tax-filing/review/active/route');
    const res = await GET(new NextRequest('http://localhost/api/v1/agentbook-tax/tax-filing/review/active'));
    expect(await res.json()).toEqual({ success: true, data: { active: false } });
  });

  it('POST review/start delegates to startReview for the resolved tenant + year', async () => {
    startReview.mockResolvedValue({ message: 'summary', criticalFields: [], computedTotals: {} });
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/start/route');
    const res = await POST(post('http://localhost/x'), YEAR);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.message).toBe('summary');
    expect(startReview.mock.calls[0].slice(0, 2)).toEqual(['tenant-1', 2025]);
    expect(typeof startReview.mock.calls[0][2]).toBe('function'); // callGemini injected
  });

  it('POST review/message passes the user text through to answerReviewMessage', async () => {
    answerReviewMessage.mockResolvedValue({ message: 'answered' });
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/message/route');
    const res = await POST(post('http://localhost/x', { text: 'why is my tax so high?' }), YEAR);
    expect((await res.json()).data.message).toBe('answered');
    expect(answerReviewMessage.mock.calls[0].slice(0, 3)).toEqual(['tenant-1', 2025, 'why is my tax so high?']);
  });

  it('GET review/status reports hasConfirmedFreshReview', async () => {
    hasConfirmedFreshReview.mockResolvedValue(true);
    const { GET } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/status/route');
    const res = await GET(new NextRequest('http://localhost/x'), YEAR);
    expect(await res.json()).toEqual({ success: true, data: { confirmedAndFresh: true } });
    expect(hasConfirmedFreshReview).toHaveBeenCalledWith('tenant-1', 2025);
  });

  it('POST review/edit-field delegates the exact formCode/fieldId/valueCents', async () => {
    applyFieldEdit.mockResolvedValue({ message: 'Updated', computedTotals: {} });
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/edit-field/route');
    const res = await POST(post('http://localhost/x', { formCode: 'T1', fieldId: 'taxable_income_26000', valueCents: 8000000 }), YEAR);
    expect((await res.json()).success).toBe(true);
    expect(applyFieldEdit).toHaveBeenCalledWith('tenant-1', 2025, 'T1', 'taxable_income_26000', 8000000);
  });

  it('POST review/edit-field 400s on a missing formCode/fieldId', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/edit-field/route');
    const res = await POST(post('http://localhost/x', { valueCents: 1 }), YEAR);
    expect(res.status).toBe(400);
    expect(applyFieldEdit).not.toHaveBeenCalled();
  });

  it('POST review/confirm delegates to confirmAndSubmit', async () => {
    confirmAndSubmit.mockResolvedValue({ message: 'Filed!', filed: true });
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/confirm/route');
    const res = await POST(post('http://localhost/x'), YEAR);
    expect((await res.json()).data).toEqual({ message: 'Filed!', filed: true });
    expect(confirmAndSubmit).toHaveBeenCalledWith('tenant-1', 2025);
  });

  it('a thrown error becomes a 500 JSON envelope, not an unhandled rejection', async () => {
    confirmAndSubmit.mockRejectedValue(new Error('no filing found'));
    const { POST } = await import('@/app/api/v1/agentbook-tax/tax-filing/[year]/review/confirm/route');
    const res = await POST(post('http://localhost/x'), YEAR);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('no filing found');
  });
});
