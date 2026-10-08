import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMobileData, readSnapshot, writeSnapshot, SNAPSHOT_EVENT, SNAPSHOT_CLEARED_EVENT } from '@/app/app/_lib/useMobileData';
import { SNAPSHOT_PREFIX, clearMobileSnapshots, claimMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { ApiError } from '@/app/app/_lib/api';

const SAVED_AT = '2026-10-07T14:30:00.000Z';

beforeEach(() => {
  window.localStorage.clear();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useMobileData', () => {
  it('loads, then stores a last-good snapshot under ab:mobile:<key>', async () => {
    const { result } = renderHook(() => useMobileData('home', () => Promise.resolve({ n: 1 })));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(result.current).toMatchObject({ loading: false, refreshing: false, offline: false, staleAt: null, error: null });
    const snap = JSON.parse(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`) as string);
    expect(snap.data).toEqual({ n: 1 });
    expect(Number.isNaN(Date.parse(snap.savedAt))).toBe(false);
  });

  it('a connectivity failure serves the snapshot, flags offline, and sets staleAt to when it was saved', async () => {
    writeSnapshot('home', { n: 7 }, SAVED_AT);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('network', 0, 'network'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: { n: 7 }, offline: true, staleAt: SAVED_AT });
    expect(result.current.error).toBeInstanceOf(ApiError);
  });

  it('a server error with a snapshot serves it as stale but NOT offline', async () => {
    writeSnapshot('home', { n: 7 }, SAVED_AT);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('boom', 500, 'http_500'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: { n: 7 }, offline: false, staleAt: SAVED_AT });
  });

  it('a failure with no snapshot is an error state with no data and no staleAt', async () => {
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('boom', 500))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: null, staleAt: null, offline: false });
    expect(result.current.error?.message).toBe('boom');
  });

  it('navigator.onLine === false marks a failure offline even for a non-network error', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new Error('whatever'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offline).toBe(true);
  });

  it('a plain TypeError from fetch counts as connectivity', async () => {
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new TypeError('Failed to fetch'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offline).toBe(true);
  });

  it('reload refetches, keeps showing data while refreshing, and replaces it on success', async () => {
    const second = deferred<{ n: number }>();
    const fetcher = vi.fn().mockResolvedValueOnce({ n: 1 }).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useMobileData('home', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ n: 1 });
    await act(async () => { second.resolve({ n: 2 }); });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a failed reload keeps the live data and marks it stale as of the last success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ n: 1 }).mockRejectedValueOnce(new ApiError('network', 0, 'network'));
    const { result } = renderHook(() => useMobileData('home', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    const savedAt = JSON.parse(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`) as string).savedAt;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current).toMatchObject({ data: { n: 1 }, staleAt: savedAt });
  });

  it('going offline (window event) labels the data as of the last success without a request', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => useMobileData('home', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(result.current.offline).toBe(true);
    expect(result.current.staleAt).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('coming back online refetches', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => useMobileData('home', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.offline).toBe(false));
  });

  it('survives a localStorage that throws on every access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useMobileData('home', () => Promise.resolve({ n: 3 })));
    await waitFor(() => expect(result.current.data).toEqual({ n: 3 }));
    expect(readSnapshot('home')).toBeNull();
  });

  it('ignores a corrupt snapshot rather than crashing', async () => {
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{not json');
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('network', 0, 'network'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.staleAt).toBeNull();
  });
});

describe('snapshot helpers', () => {
  it('writeSnapshot announces the key so the shell badges can follow along', () => {
    const seen: string[] = [];
    const onSnap = (e: Event) => seen.push((e as CustomEvent<{ key: string }>).detail.key);
    window.addEventListener(SNAPSHOT_EVENT, onSnap);
    writeSnapshot('home', { n: 1 });
    window.removeEventListener(SNAPSHOT_EVENT, onSnap);
    expect(seen).toEqual(['home']);
  });

  it('clearMobileSnapshots removes every ab:mobile: key and nothing else', () => {
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{}');
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}docs`, '{}');
    window.localStorage.setItem('theme', 'dark');
    clearMobileSnapshots();
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs`)).toBeNull();
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });
});

describe('useMobileData: session expiry', () => {
  it('a 401 with a snapshot drops it: no data, no staleAt, error.code unauthorized, storage cleared', async () => {
    writeSnapshot('home', { n: 7 }, SAVED_AT);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('expired', 401, 'unauthorized'))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: null, staleAt: null, offline: false });
    expect((result.current.error as ApiError).code).toBe('unauthorized');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
  });

  it('a 401 after a live success also drops the in-memory last-good', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ n: 1 }).mockRejectedValueOnce(new ApiError('expired', 401, 'unauthorized'));
    const { result } = renderHook(() => useMobileData('home', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current).toMatchObject({ data: null, staleAt: null });
  });

  it('a 500 or a network failure still serves the snapshot with staleAt', async () => {
    for (const err of [new ApiError('boom', 500, 'http_500'), new ApiError('network', 0, 'network')]) {
      writeSnapshot('home', { n: 7 }, SAVED_AT);
      const { result, unmount } = renderHook(() => useMobileData('home', () => Promise.reject(err)));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toMatchObject({ data: { n: 7 }, staleAt: SAVED_AT });
      unmount();
    }
  });
});

describe('useMobileData: snapshots cleared while mounted', () => {
  it('a mounted hook showing a stale snapshot drops it when snapshots are cleared', async () => {
    writeSnapshot('home', { n: 7 }, SAVED_AT);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('boom', 500))));
    await waitFor(() => expect(result.current.staleAt).toBe(SAVED_AT));
    act(() => clearMobileSnapshots());
    expect(result.current).toMatchObject({ data: null, staleAt: null });
    expect(result.current.error).not.toBeNull();
  });

  it('claiming for a different user drops a mounted stale snapshot', async () => {
    claimMobileSnapshots('u1');
    writeSnapshot('home', { n: 7 }, SAVED_AT);
    const { result } = renderHook(() => useMobileData('home', () => Promise.reject(new ApiError('boom', 500))));
    await waitFor(() => expect(result.current.staleAt).toBe(SAVED_AT));
    act(() => claimMobileSnapshots('u2'));
    expect(result.current).toMatchObject({ data: null, staleAt: null });
  });

  it('live (non-stale) data is NOT dropped by the clear event', async () => {
    const { result } = renderHook(() => useMobileData('home', () => Promise.resolve({ n: 1 })));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => clearMobileSnapshots());
    expect(result.current.data).toEqual({ n: 1 });
  });

  it('removes its clear listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useMobileData('home', () => Promise.resolve({ n: 1 })));
    unmount();
    const added = add.mock.calls.filter((c) => c[0] === SNAPSHOT_CLEARED_EVENT).length;
    const removed = remove.mock.calls.filter((c) => c[0] === SNAPSHOT_CLEARED_EVENT).length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

describe('useMobileData: key changes and races', () => {
  it('a key change resets data immediately instead of showing the previous key\'s list', async () => {
    const second = deferred<{ n: number }>();
    const fetcher = vi.fn((k: string) => (k === 'a' ? Promise.resolve({ n: 1 }) : second.promise));
    const { result, rerender } = renderHook(({ k }) => useMobileData(k, () => fetcher(k)), { initialProps: { k: 'a' } });
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    rerender({ k: 'b' });
    expect(result.current).toMatchObject({ data: null, loading: true, staleAt: null, error: null });
    await act(async () => { second.resolve({ n: 2 }); });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
  });

  it('a late response from the OLD key never overwrites the new key', async () => {
    const first = deferred<{ n: number }>();
    const fetcher = vi.fn((k: string) => (k === 'a' ? first.promise : Promise.resolve({ n: 2 })));
    const { result, rerender } = renderHook(({ k }) => useMobileData(k, () => fetcher(k)), { initialProps: { k: 'a' } });
    rerender({ k: 'b' });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    await act(async () => { first.resolve({ n: 1 }); });
    expect(result.current.data).toEqual({ n: 2 });
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}a`)).toBeNull();
  });

  it('a failure on the new key serves the NEW key\'s snapshot, not the old one', async () => {
    writeSnapshot('b', { n: 99 }, SAVED_AT);
    const fetcher = (k: string) => (k === 'a' ? Promise.resolve({ n: 1 }) : Promise.reject(new ApiError('boom', 500)));
    const { result, rerender } = renderHook(({ k }) => useMobileData(k, () => fetcher(k)), { initialProps: { k: 'a' } });
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    rerender({ k: 'b' });
    await waitFor(() => expect(result.current.staleAt).toBe(SAVED_AT));
    expect(result.current.data).toEqual({ n: 99 });
  });

  it('unmounting mid-fetch causes no state update, act warning or unhandled rejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ok = deferred<{ n: number }>();
      const bad = deferred<{ n: number }>();
      const a = renderHook(() => useMobileData('a', () => ok.promise));
      const b = renderHook(() => useMobileData('b', () => bad.promise));
      a.unmount();
      b.unmount();
      await act(async () => { ok.resolve({ n: 1 }); bad.reject(new ApiError('boom', 500)); });
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}a`)).toBeNull();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('after a rapid reload the second response wins even if the first lands last', async () => {
    const first = deferred<{ n: number }>();
    const second = deferred<{ n: number }>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useMobileData('home', fetcher));
    act(() => result.current.reload());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve({ n: 2 }); });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    await act(async () => { first.resolve({ n: 1 }); });
    expect(result.current.data).toEqual({ n: 2 });
  });
});

describe('writeSnapshot: per-family cap', () => {
  const keysOf = (family: string) =>
    Object.keys(window.localStorage).filter((k) => k.startsWith(`${SNAPSHOT_PREFIX}${family}`));

  it('keeps at most 8 snapshots per "family:" prefix, evicting the oldest by savedAt', () => {
    for (let i = 0; i < 12; i++) writeSnapshot(`docs:q${i}`, { i }, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
    const kept = keysOf('docs:');
    expect(kept).toHaveLength(8);
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:q0`)).toBeNull();
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:q3`)).toBeNull();
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:q4`)).not.toBeNull();
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:q11`)).not.toBeNull();
  });

  it('never evicts the key just written, even with an old savedAt, and leaves other families alone', () => {
    writeSnapshot('home', { n: 1 }, SAVED_AT);
    for (let i = 0; i < 8; i++) writeSnapshot(`docs:q${i}`, { i }, new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString());
    writeSnapshot('docs:old', { i: 'old' }, '2020-01-01T00:00:00.000Z');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}docs:old`)).not.toBeNull();
    expect(keysOf('docs:')).toHaveLength(8);
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).not.toBeNull();
  });

  it('survives storage that throws while evicting', () => {
    for (let i = 0; i < 9; i++) writeSnapshot(`docs:q${i}`, { i });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => writeSnapshot('docs:more', { i: 1 })).not.toThrow();
  });
});
