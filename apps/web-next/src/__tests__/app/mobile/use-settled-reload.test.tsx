/**
 * useSettledReload — the pull gesture's promise must settle when the load it
 * started has finished, however React happened to commit that load.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useSettledReload, SETTLED_RELOAD_TIMEOUT_MS, type SettledReloadState } from '@/app/app/_lib/useSettledReload';

interface Harness {
  run: () => Promise<void>;
  set: (s: Partial<SettledReloadState>) => void;
  reload: ReturnType<typeof vi.fn>;
}

function mount(initial: Partial<SettledReloadState> = {}) {
  const h = { reload: vi.fn() } as unknown as Harness;
  function Probe() {
    const [state, setState] = useState<SettledReloadState>({ busy: false, data: { v: 1 }, error: null, staleAt: null, ...initial });
    h.set = (s) => setState((prev) => ({ ...prev, ...s }));
    h.run = useSettledReload(h.reload, state);
    return null;
  }
  const view = render(<Probe />);
  return { h, view };
}

/** Track a promise's settlement without awaiting it. */
function track(p: Promise<void>) {
  const out = { settled: false };
  void p.then(() => { out.settled = true; });
  return out;
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => {
  vi.useRealTimers();
});

describe('useSettledReload', () => {
  it('resolves after the data hook goes busy and comes back', async () => {
    const { h } = mount();
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    expect(h.reload).toHaveBeenCalledTimes(1);
    act(() => h.set({ busy: true }));
    await flush();
    expect(t.settled).toBe(false);
    act(() => h.set({ busy: false, data: { v: 2 } }));
    await flush();
    expect(t.settled).toBe(true);
  });

  it('resolves when the busy edge is never committed (shared in-flight request answered in the same batch)', async () => {
    const { h } = mount();
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    // Both updates land in one batch: React never commits busy=true.
    act(() => {
      h.set({ busy: true });
      h.set({ busy: false, data: { v: 2 } });
    });
    await flush();
    expect(t.settled).toBe(true);
  });

  it('a new error (with the same cached data) also counts as the load finishing', async () => {
    const data = { v: 1 };
    const { h } = mount({ data });
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    act(() => {
      h.set({ busy: true });
      h.set({ busy: false, data, error: new Error('offline'), staleAt: '2026-10-07T14:30:00.000Z' });
    });
    await flush();
    expect(t.settled).toBe(true);
  });

  it('does not resolve while nothing has happened yet', async () => {
    const { h } = mount();
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    await flush();
    expect(t.settled).toBe(false);
  });

  it(`a safety timeout (${SETTLED_RELOAD_TIMEOUT_MS} ms) releases a waiter nobody reported`, async () => {
    vi.useFakeTimers();
    const { h } = mount();
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    await act(async () => { vi.advanceTimersByTime(SETTLED_RELOAD_TIMEOUT_MS - 1); });
    expect(t.settled).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(t.settled).toBe(true);
  });

  it('unmount releases waiters and clears the timer', async () => {
    vi.useFakeTimers();
    const { h, view } = mount();
    let t!: { settled: boolean };
    act(() => { t = track(h.run()); });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(t.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
