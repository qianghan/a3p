import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeployments, useDeployment } from '../../hooks/useDeployments';

const mockDeployments = [
  { id: '1', name: 'deploy-a', status: 'ONLINE', healthStatus: 'GREEN', providerSlug: 'fal-ai' },
  { id: '2', name: 'deploy-b', status: 'FAILED', healthStatus: 'RED', providerSlug: 'runpod' },
];

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeployments', () => {
  it('should start in loading state', () => {
    (global.fetch as any).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });
    const { result } = renderHook(() => useDeployments());
    expect(result.current.loading).toBe(true);
  });

  it('should fetch and set deployments on success', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    const { result } = renderHook(() => useDeployments());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deployments).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('should set error on failure response', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      json: async () => ({ success: false, error: 'Server error' }),
    });
    const { result } = renderHook(() => useDeployments());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Server error');
  });

  it('should set error on fetch exception', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderHook(() => useDeployments());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network error');
  });

  it('should re-fetch on refresh', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: [mockDeployments[0]] }) })
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: mockDeployments }) });
    const { result } = renderHook(() => useDeployments());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deployments).toHaveLength(1);
    await result.current.refresh();
    await waitFor(() => expect(result.current.deployments).toHaveLength(2));
  });
});

describe('useDeployment', () => {
  it('should fetch single deployment by id', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockDeployments[0] }),
    });
    const { result } = renderHook(() => useDeployment('1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deployment).toEqual(mockDeployments[0]);
  });

  it('should handle fetch failure gracefully', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Not found'));
    const { result } = renderHook(() => useDeployment('999'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deployment).toBeNull();
  });
});
