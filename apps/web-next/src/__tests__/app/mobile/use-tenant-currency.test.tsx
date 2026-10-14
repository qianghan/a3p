import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTenantCurrency } from '@/app/app/_lib/useTenantCurrency';
import { jsonResponse } from './test-utils';
import './_load-tolerance';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTenantCurrency', () => {
  it('is null until the config is known (never a guessed USD), then the resolved currency', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { currency: 'USD', jurisdiction: 'ca' } }));
    const { result } = renderHook(() => useTenantCurrency());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('CAD'));
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-core/tenant-config');
  });

  it('stays null when the config cannot be fetched and no snapshot exists', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useTenantCurrency());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });

  it('serves the last good currency when offline (snapshot written on the first success)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { currency: 'AUD', jurisdiction: 'au' } }));
    const first = renderHook(() => useTenantCurrency());
    await waitFor(() => expect(first.result.current).toBe('AUD'));
    first.unmount();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const second = renderHook(() => useTenantCurrency());
    await waitFor(() => expect(second.result.current).toBe('AUD'));
  });
});
