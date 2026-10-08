import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMobileData, readSnapshot, writeSnapshot, SNAPSHOT_EVENT } from '@/app/app/_lib/useMobileData';
import { SNAPSHOT_PREFIX, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
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
