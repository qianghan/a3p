import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `ingestReceipt` — the one call every channel makes when a receipt arrives.
 *
 * It exists so a second adapter cannot pick up three of the four steps. The
 * one most easily missed is the FIRST: `ocr_scans` is a metered, billed
 * quota, and a channel that scanned without consulting it would be a free
 * bypass of a paid feature. WhatsApp shipped text-only partly because
 * reimplementing this was the alternative.
 *
 * The channel tests mock this module out — they are testing routing, not
 * this. So the quota gate has to be tested here, against the real function,
 * or it is tested nowhere.
 */

vi.mock('server-only', () => ({}));

const checkQuota = vi.fn();
const incrementUsage = vi.fn();
vi.mock('@naap/billing', () => ({
  checkQuota: (...a: unknown[]) => checkQuota(...a),
  incrementUsage: (...a: unknown[]) => incrementUsage(...a),
}));

const vendorUpsert = vi.fn();
const expenseCreate = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abVendor: { upsert: (...a: unknown[]) => vendorUpsert(...a) },
    abPattern: { findUnique: vi.fn().mockResolvedValue(null) },
    abExpense: { create: (...a: unknown[]) => expenseCreate(...a) },
    abLLMProviderConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    abEvent: { create: vi.fn() },
    abAccount: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { ingestReceipt } from '../agentbook-receipt-ocr';

const IMG = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');

beforeEach(() => {
  vi.restoreAllMocks();
  checkQuota.mockReset();
  incrementUsage.mockReset().mockResolvedValue(undefined);
  vendorUpsert.mockReset();
  expenseCreate.mockReset();
  delete process.env.GEMINI_API_KEY;
});

describe('the quota gate comes first', () => {
  it('refuses at limit and never spends an OCR call', async () => {
    checkQuota.mockResolvedValue({ allowed: false, limit: 20 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const r = await ingestReceipt({ tenantId: 't1', fileUrl: IMG, mimeType: 'image/jpeg', source: 'whatsapp_photo' });

    expect(r).toEqual({ ok: false, reason: 'quota', limit: 20 });
    // No model call, no download, no row. Refusing after the spend would
    // bill the plan for work the user was told they could not have.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(expenseCreate).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  it('counts the scan against the quota when it is allowed', async () => {
    checkQuota.mockResolvedValue({ allowed: true, limit: 20 });
    await ingestReceipt({ tenantId: 't1', fileUrl: IMG, mimeType: 'image/jpeg', source: 'whatsapp_photo' });
    expect(incrementUsage).toHaveBeenCalledWith('t1', 'ocr_scans', 1);
  });

  it('fails OPEN when billing itself is unavailable', async () => {
    // A quota service that is down should not stop someone filing expenses.
    // Distinct from an over-limit answer, which fails closed.
    checkQuota.mockRejectedValue(new Error('billing down'));
    const r = await ingestReceipt({ tenantId: 't1', fileUrl: IMG, mimeType: 'image/jpeg', source: 'whatsapp_photo' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toBe('quota');
  });
});

describe('what it refuses to book', () => {
  beforeEach(() => {
    checkQuota.mockResolvedValue({ allowed: true, limit: 20 });
    process.env.GEMINI_API_KEY = 'test-key';
  });

  const stubGemini = (payload: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).includes('generativelanguage')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }), { status: 200 });
    }
    return new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }));

  it('does not create a zero-value expense when the total could not be read', async () => {
    // The model's own way of saying "I could not read it" is amount 0 with
    // confidence 0. Booking that puts a silent wrong number in the ledger.
    stubGemini({ amount_cents: 0, vendor: null, date: '2026-01-01', currency: 'AUD', items: null, tax_cents: 0, tip_cents: 0, confidence: 0 });
    const r = await ingestReceipt({ tenantId: 't1', fileUrl: IMG, mimeType: 'image/jpeg', source: 'whatsapp_photo' });
    expect(r).toEqual({ ok: false, reason: 'unreadable' });
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it('reports ocr_failed when there is no model configured at all', async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await ingestReceipt({ tenantId: 't1', fileUrl: IMG, mimeType: 'image/jpeg', source: 'whatsapp_photo' });
    expect(r).toEqual({ ok: false, reason: 'ocr_failed' });
    expect(expenseCreate).not.toHaveBeenCalled();
  });
});
