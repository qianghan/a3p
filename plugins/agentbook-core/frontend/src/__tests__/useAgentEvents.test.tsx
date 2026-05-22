import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentEvents } from '../hooks/useAgentEvents';

// Tests use REAL timers because the hook's polling lifecycle interacts with
// React's effect cleanup, and fake-timer interleaving with waitFor causes
// hangs in this jsdom environment. Polls are configured to fire every 50ms
// so tests complete quickly.

describe('useAgentEvents (PR 28)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ latestAt: null, count: 0, kinds: {} }),
    } as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('polls on mount with current timestamp', async () => {
    renderHook(() => useAgentEvents({ intervalMs: 50 }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const firstCall = (fetchSpy.mock.calls[0][0] as string) || '';
    expect(firstCall).toContain('/api/v1/agentbook-core/events/since');
    expect(firstCall).toContain('ts=');
  });

  it('returns default state until first response', () => {
    const { result } = renderHook(() => useAgentEvents({ intervalMs: 50 }));
    expect(result.current).toEqual({ lastChange: 0, kinds: {}, latestAt: null });
  });

  it('does not bump lastChange when no events arrive', async () => {
    const { result } = renderHook(() => useAgentEvents({ intervalMs: 50 }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // Give a few extra polls a chance to fire.
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.lastChange).toBe(0);
  });

  it('bumps lastChange when matching events arrive', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        latestAt: '2026-05-22T12:00:00.000Z',
        count: 1,
        kinds: { 'expense.created': 1 },
      }),
    } as never);

    const { result } = renderHook(() => useAgentEvents({ intervalMs: 50 }));
    await waitFor(() => expect(result.current.lastChange).toBe(1), { timeout: 2000 });
    expect(result.current.kinds).toEqual({ 'expense.created': 1 });
    expect(result.current.latestAt).toBe('2026-05-22T12:00:00.000Z');
  });

  it('filters by kinds — does not bump lastChange when only unwanted kinds arrive', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        latestAt: '2026-05-22T12:00:00.000Z',
        count: 1,
        kinds: { 'invoice.sent': 1 },
      }),
    } as never);

    const { result } = renderHook(() =>
      useAgentEvents({ intervalMs: 50, kinds: ['expense.created'] }),
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.lastChange).toBe(0);
  });

  it('matches kind prefixes (kinds=["expense"] matches "expense.created")', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        latestAt: '2026-05-22T12:00:00.000Z',
        count: 2,
        kinds: { 'expense.created': 1, 'expense.confirmed': 1 },
      }),
    } as never);

    const { result } = renderHook(() => useAgentEvents({ intervalMs: 50, kinds: ['expense'] }));
    await waitFor(() => expect(result.current.lastChange).toBe(1), { timeout: 2000 });
  });

  it('does not poll when disabled', async () => {
    renderHook(() => useAgentEvents({ intervalMs: 50, disabled: true }));
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles fetch errors gracefully — does not throw or bump state', async () => {
    fetchSpy.mockRejectedValue(new Error('net error'));
    const { result } = renderHook(() => useAgentEvents({ intervalMs: 50 }));
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.lastChange).toBe(0);
  });
});
