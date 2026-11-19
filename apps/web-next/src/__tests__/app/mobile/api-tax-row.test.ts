/**
 * PR 2b.8 — the tax-row client functions, through a mocked global fetch
 * (never by mocking api.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTaxRow, patchDoc, ApiError } from '@/app/app/_lib/api';
import { jsonResponse, textResponse } from './test-utils';

const VIEW = {
  visible: true, codes: [{ code: 'GST', recoverable: true }], defaultCode: 'GST', registrationPrompt: false,
  preview: { taxCode: 'GST', inclusive: false, grossCents: 11000, netCents: 10000, taxCents: 1000 },
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('getTaxRow', () => {
  it('GETs the tax-codes view with amount, mode and code in the query', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: VIEW }));
    const v = await getTaxRow({ amountCents: 10000, inclusive: false, taxCode: 'GST' });
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x');
    expect(url.pathname).toBe('/api/v1/agentbook-expense/tax-codes');
    expect(Object.fromEntries(url.searchParams)).toEqual({ amountCents: '10000', inclusive: 'false', taxCode: 'GST' });
    expect(v.preview?.grossCents).toBe(11000);
  });
  it('omits an absent amount/code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: VIEW }));
    await getTaxRow({ inclusive: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-expense/tax-codes?inclusive=true');
  });
  it('a malformed body reads as hidden, never throws a TypeError later', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { visible: 'yes' } }));
    await expect(getTaxRow({ inclusive: true })).resolves.toMatchObject({ visible: false, preview: null });
  });
  it('a failure is an ApiError', async () => {
    fetchMock.mockResolvedValue(textResponse(502, 'bad gateway'));
    await expect(getTaxRow({ inclusive: true })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('patchDoc taxCode', () => {
  it('sends taxCode through the allow-list', async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? jsonResponse(200, { success: true, data: { id: 'e1' } })
        : jsonResponse(200, { success: true, data: { id: 'e1', date: '2026-10-01', amountCents: 11000, status: 'confirmed', isPersonal: false } }));
    await patchDoc('e1', { taxCode: 'GST' });
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ taxCode: 'GST' });
  });
});
