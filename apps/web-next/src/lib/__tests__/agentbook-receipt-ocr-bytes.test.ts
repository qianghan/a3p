// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
const checkQuota = vi.fn();
const incrementUsage = vi.fn();
vi.mock('@naap/billing', () => ({
  checkQuota: (...a: unknown[]) => checkQuota(...a),
  incrementUsage: (...a: unknown[]) => incrementUsage(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: { abLLMProviderConfig: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

import { ocrReceiptBytes, ocrReceipt, checkOcrQuota } from '../agentbook-receipt-ocr';

const geminiReply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  checkQuota.mockReset();
  incrementUsage.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEY;
});

describe('ocrReceiptBytes', () => {
  it('sends the bytes inline (no download) and reports that a date was found', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      geminiReply('{"amount_cents": 4599, "vendor": "Shell", "date": "2026-06-19", "currency": "CAD", "items": null, "tax_cents": 0, "tip_cents": 0, "confidence": 0.93}'),
    );
    const r = await ocrReceiptBytes(BYTES, 'image/jpeg', 'upload');
    expect(r).toMatchObject({ amount_cents: 4599, vendor: 'Shell', date: '2026-06-19', dateFound: true, confidence: 0.93 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/jpeg', data: BYTES.toString('base64') });
  });

  it('dateFound is false when the model returns no date (the date falls back to today)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(geminiReply('{"amount_cents": 100, "vendor": null, "confidence": 0.2}'));
    const r = await ocrReceiptBytes(BYTES, 'image/jpeg');
    expect(r?.dateFound).toBe(false);
    expect(r?.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('returns null without calling the model when no key is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await ocrReceiptBytes(BYTES, 'image/jpeg')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ocrReceipt (URL) keeps its exact old return shape — no dateFound leaks out', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } }))
      .mockResolvedValueOnce(geminiReply('{"amount_cents": 4599, "vendor": "Shell", "date": "2026-06-19", "confidence": 0.9}'));
    const r = await ocrReceipt('https://files.test/r.jpg');
    expect(r).toEqual({ amount_cents: 4599, vendor: 'Shell', date: '2026-06-19', currency: 'USD', items: null, tax_cents: 0, tip_cents: 0, confidence: 0.9 });
  });
});

describe('checkOcrQuota', () => {
  it('refuses at the limit', async () => {
    checkQuota.mockResolvedValue({ allowed: false, limit: 20 });
    expect(await checkOcrQuota('t1')).toEqual({ allowed: false, limit: 20 });
    expect(incrementUsage).not.toHaveBeenCalled();
  });
  it('meters an allowed scan', async () => {
    checkQuota.mockResolvedValue({ allowed: true, limit: 20 });
    expect(await checkOcrQuota('t1')).toEqual({ allowed: true });
    expect(incrementUsage).toHaveBeenCalledWith('t1', 'ocr_scans', 1);
  });
  it('fails open when billing is down', async () => {
    checkQuota.mockRejectedValue(new Error('billing down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkOcrQuota('t1')).toEqual({ allowed: true });
  });
});
