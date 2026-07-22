/**
 * useBasiqConnect — AU-1 Task 4 shared popup/poll hook.
 *
 * Extracted from `plugins/agentbook-expense/frontend/src/pages/
 * BankConnection.tsx`'s original inline implementation (Task 3, PR #318).
 * These tests cover the behaviors that file's own test suite already
 * exercised end-to-end through the page component, at the hook level:
 * success, failure, timeout, popup-closed, and cancelled (null jobId).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBasiqConnect, BASIQ_TIMEOUT_MS, BASIQ_POLL_MS } from '../useBasiqConnect';

function jsonResponse(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) } as Response);
}

describe('useBasiqConnect', () => {
  const API = '/api/v1/agentbook-expense';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts connecting, opens a popup, and calls onConnected once status polls to success', async () => {
    const popup = { closed: false } as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/bank/basiq/status')) {
        return jsonResponse({ success: true, data: { status: 'success', accountsLinked: 2 } });
      }
      return jsonResponse({ success: true, data: {} });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onConnected = vi.fn();
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected }));

    act(() => {
      result.current.setConnecting(true);
      result.current.startConnect('https://consent.basiq.io/home?token=abc');
    });

    expect(window.open).toHaveBeenCalledWith(
      'https://consent.basiq.io/home?token=abc',
      'basiq-consent',
      'width=480,height=720',
    );
    expect(result.current.connecting).toBe(true);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { basiqJobId: 'job-123' },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASIQ_POLL_MS);
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(2));
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
    const statusCalls = mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/bank/basiq/status'));
    expect(statusCalls.length).toBeGreaterThan(0);
    expect(String(statusCalls[0][0])).toContain('jobId=job-123');
  });

  it('stops cleanly with no error when the callback posts basiqJobId: null (user cancelled)', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    const mockFetch = vi.fn().mockImplementation(() => {
      throw new Error('status should never be polled when jobId is null');
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onConnected = vi.fn();
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected }));

    act(() => {
      result.current.setConnecting(true);
      result.current.startConnect('https://consent.basiq.io/home?token=abc');
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { basiqJobId: null },
      }));
    });

    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sets an error and stops when the status poll reports failed', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/bank/basiq/status')) {
        return jsonResponse({ success: true, data: { status: 'failed', error: 'bank declined' } });
      }
      return jsonResponse({ success: true, data: {} });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onConnected = vi.fn();
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected }));

    act(() => {
      result.current.setConnecting(true);
      result.current.startConnect('https://consent.basiq.io/home?token=abc');
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { basiqJobId: 'job-456' },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASIQ_POLL_MS);
    });

    await waitFor(() => expect(result.current.error).toMatch(/bank declined/));
    expect(result.current.connecting).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('times out after BASIQ_TIMEOUT_MS of unresolved polling', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/bank/basiq/status')) {
        return jsonResponse({ success: true, data: { status: 'in-progress' } });
      }
      return jsonResponse({ success: true, data: {} });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const onConnected = vi.fn();
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected }));

    act(() => {
      result.current.setConnecting(true);
      result.current.startConnect('https://consent.basiq.io/home?token=abc');
    });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { basiqJobId: 'job-789' },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASIQ_TIMEOUT_MS + BASIQ_POLL_MS);
    });

    await waitFor(() => expect(result.current.error).toMatch(/timed out/i));
    expect(result.current.connecting).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('stops waiting if the popup is closed before any message arrives', async () => {
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockReturnValue(popup as Window);
    global.fetch = vi.fn() as unknown as typeof fetch;

    const onConnected = vi.fn();
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected }));

    act(() => {
      result.current.setConnecting(true);
      result.current.startConnect('https://consent.basiq.io/home?token=abc');
    });

    popup.closed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('setError/clearError let the caller report an initial consent-url fetch failure', () => {
    const { result } = renderHook(() => useBasiqConnect({ apiBase: API, onConnected: vi.fn() }));

    act(() => {
      result.current.setConnecting(true);
      result.current.setError('Failed to start bank connection: boom');
      result.current.setConnecting(false);
    });

    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBe('Failed to start bank connection: boom');

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
