/** suggestCategoryFor through a mocked global fetch — never by mocking the module. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { suggestCategoryFor } from '@/app/app/_lib/api-extra';
import { jsonResponse } from './test-utils';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const SUG = { categoryId: 'c1', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };

describe('suggestCategoryFor', () => {
  it('GETs the suggest route with the vendor encoded, same-origin credentials, and returns the suggestion', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: SUG }));
    expect(await suggestCategoryFor({ vendor: 'Café & Co', amountCents: 450 })).toEqual(SUG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/v1/agentbook-expense/categories/suggest?vendor=Caf%C3%A9+%26+Co&amountCents=450');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBeUndefined();
  });

  it('makes no request for a blank vendor and no description', async () => {
    expect(await suggestCategoryFor({ vendor: '   ' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('data:null means no suggestion', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: null }));
    expect(await suggestCategoryFor({ vendor: 'Mystery' })).toBeNull();
  });

  it('a suggestion is a convenience: network failure, HTTP error and malformed data all become null, never a throw', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await suggestCategoryFor({ vendor: 'A' })).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false, error: 'boom' }));
    expect(await suggestCategoryFor({ vendor: 'A' })).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { categoryName: 'Meals' } }));
    expect(await suggestCategoryFor({ vendor: 'A' })).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { ...SUG, confidence: 'high' } }));
    expect(await suggestCategoryFor({ vendor: 'A' })).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { ...SUG, source: 'witchcraft' } }));
    expect(await suggestCategoryFor({ vendor: 'A' })).toBeNull();
  });
});
