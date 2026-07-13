import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startupApi } from '../api';

/**
 * Unlike every other test in this plugin, this one does NOT mock '../lib/api'
 * — it mocks the underlying `fetch` and exercises the real json()/fetch
 * plumbing. Every other test file mocks startupApi wholesale, which is
 * correct for testing the *pages* but means a bug inside api.ts itself
 * (e.g. forgetting to `await fetch(...)` before passing it to the response
 * parser) is invisible to the rest of the suite. This file exists to close
 * exactly that gap — found in production via a "e.text is not a function"
 * error after all page-level tests passed.
 */
describe('startupApi (real fetch plumbing)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('createApplication resolves with the parsed JSON body on a 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ application: { id: 'app-1', status: 'docs_pending' }, documentChecklist: [] }),
    });
    const result = await startupApi.createApplication('us_rd_credit_41');
    expect(result.application.id).toBe('app-1');
  });

  it.each([
    ['listApplications', () => startupApi.listApplications()],
    ['getApplication', () => startupApi.getApplication('app-1')],
    ['triggerDraft', () => startupApi.triggerDraft('app-1')],
    ['respondToDecisionPoint', () => startupApi.respondToDecisionPoint('dp-1', 'approve')],
  ])('%s resolves with the parsed JSON body on a 200 (not "text is not a function")', async (_name, call) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    await expect(call()).resolves.toEqual({ ok: true });
  });

  it('uploadDocument resolves with the parsed JSON body on a 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { id: 'doc-1' } }),
    });
    const result = await startupApi.uploadDocument('app-1', 'payroll_register', new File([], 'x.pdf'));
    expect(result.document.id).toBe('doc-1');
  });

  it('rejects with the real response text when the server returns a non-ok status', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'add-on required',
    });
    await expect(startupApi.createApplication('us_rd_credit_41')).rejects.toThrow('402 add-on required');
  });

  it('runAuditReview posts to the audit-review endpoint and awaits the response before parsing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ application: { id: 'app-1', status: 'audit_reviewed' }, auditReview: { riskLevel: 'low', findings: [] } }),
    });
    const result = await startupApi.runAuditReview('app-1');
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/agentbook-startup/applications/app-1/audit-review', { method: 'POST' });
    expect(result.auditReview.riskLevel).toBe('low');
  });

  it('getAddOnTeaser requests the given region instead of always "us"', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ active: false, price: { tier: 'founding_member', priceCents: 12900, currency: 'aud' } }),
    });
    const result = await startupApi.getAddOnTeaser('au');
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/agentbook-billing/me/addons?code=startup_tax_benefits&region=au');
    expect(result.price?.currency).toBe('aud');
  });

  it('getTenantJurisdiction returns the tenant-config jurisdiction, falling back to "us"', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { jurisdiction: 'au' } }),
    });
    await expect(startupApi.getTenantJurisdiction()).resolves.toBe('au');
  });

  it('getTenantJurisdiction falls back to "us" when the fetch itself throws', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    await expect(startupApi.getTenantJurisdiction()).resolves.toBe('us');
  });

  it('overrideAuditFinding posts findingIndex and reason and awaits the response before parsing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ application: { id: 'app-1', status: 'audit_reviewed' }, auditReview: { riskLevel: 'low', findings: [], overrides: [{ findingIndex: 0, reason: 'fixed', overriddenAt: '2026-01-01T00:00:00.000Z' }] } }),
    });
    const result = await startupApi.overrideAuditFinding('app-1', 0, 'fixed');
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/agentbook-startup/applications/app-1/audit-review/override', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingIndex: 0, reason: 'fixed' }),
    });
    expect(result.auditReview.overrides).toHaveLength(1);
  });
});
