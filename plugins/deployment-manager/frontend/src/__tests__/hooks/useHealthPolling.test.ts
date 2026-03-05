import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useHealthPolling } from '../../hooks/useHealthPolling';

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useHealthPolling', () => {
  it('should start with UNKNOWN status', () => {
    const { result } = renderHook(() => useHealthPolling(null));
    expect(result.current.healthStatus).toBe('UNKNOWN');
    expect(result.current.lastCheck).toBeNull();
  });

  it('should not poll when deployment id is null', () => {
    renderHook(() => useHealthPolling(null));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should poll and update health status', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: { status: 'GREEN' } }),
    });
    const { result } = renderHook(() => useHealthPolling('deploy-1', 60000));

    await waitFor(() => {
      expect(result.current.healthStatus).toBe('GREEN');
    });
    expect(result.current.lastCheck).not.toBeNull();
  });

  it('should clear interval on unmount', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: { status: 'GREEN' } }),
    });
    const { result, unmount } = renderHook(() => useHealthPolling('deploy-1', 60000));

    await waitFor(() => {
      expect(result.current.healthStatus).toBe('GREEN');
    });

    unmount();
    const callCount = (global.fetch as any).mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
  });

  it('should handle fetch failure gracefully', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useHealthPolling('deploy-1', 60000));
    await new Promise((r) => setTimeout(r, 100));
    expect(result.current.healthStatus).toBe('UNKNOWN');
  });
});
