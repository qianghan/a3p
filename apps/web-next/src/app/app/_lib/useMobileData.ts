'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { SNAPSHOT_PREFIX } from '@/lib/mobile/snapshot-keys';

export { SNAPSHOT_PREFIX };

/** Fired on window after every snapshot write; detail = { key }. */
export const SNAPSHOT_EVENT = 'ab:mobile:snapshot';

export interface Snapshot<T> {
  data: T;
  savedAt: string;
}

export function readSnapshot<T>(key: string): Snapshot<T> | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(SNAPSHOT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snapshot<T>> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.savedAt !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.savedAt)) || parsed.data === undefined || parsed.data === null) return null;
    return { data: parsed.data as T, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function writeSnapshot<T>(key: string, data: T, savedAt: string = new Date().toISOString()): void {
  try {
    window.localStorage.setItem(SNAPSHOT_PREFIX + key, JSON.stringify({ data, savedAt }));
  } catch {
    // Private mode / quota: the screen still works, it just can't fall back offline.
  }
  try {
    window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail: { key } }));
  } catch {
    // No window (SSR) — nobody to tell.
  }
}

function browserOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

function isConnectivityError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0;
  return err instanceof TypeError;
}

export interface MobileDataState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  refreshing: boolean;
  offline: boolean;
  /** Set ONLY while serving a snapshot because the fetch failed or the device is offline. */
  staleAt: string | null;
}

/**
 * Loading / error / retry / offline / stale state for one /app screen (C4).
 *
 * - First load: `loading` until the fetch settles.
 * - Success: data shown, last-good snapshot written to localStorage.
 * - Failure: the in-memory last-good (or the stored snapshot) is served with
 *   `staleAt` = when it was saved; `offline` says whether connectivity is why.
 * - `reload()` keeps showing data and flips `refreshing` instead of `loading`.
 * - window 'offline' labels the data stale immediately; 'online' refetches.
 */
export function useMobileData<T>(key: string, fetcher: () => Promise<T>): MobileDataState<T> & { reload: () => void } {
  const fetcherRef = useRef(fetcher);
  const lastGood = useRef<{ key: string; snap: Snapshot<T> } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<MobileDataState<T>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
    offline: false,
    staleAt: null,
  });

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    const good = lastGood.current?.key === key ? lastGood.current.snap : null;
    setState((s) => ({ ...s, loading: good === null && s.data === null, refreshing: good !== null || s.data !== null, error: null }));

    fetcherRef.current().then(
      (data) => {
        if (cancelled) return;
        const savedAt = new Date().toISOString();
        lastGood.current = { key, snap: { data, savedAt } };
        writeSnapshot(key, data, savedAt);
        setState({ data, error: null, loading: false, refreshing: false, offline: false, staleAt: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        const offline = !browserOnline() || isConnectivityError(err);
        const fallback = (lastGood.current?.key === key ? lastGood.current.snap : null) ?? readSnapshot<T>(key);
        if (fallback) lastGood.current = { key, snap: fallback };
        setState({
          data: fallback ? fallback.data : null,
          error,
          loading: false,
          refreshing: false,
          offline,
          staleAt: fallback ? fallback.savedAt : null,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  useEffect(() => {
    const onOffline = () =>
      setState((s) => {
        const good = lastGood.current?.key === key ? lastGood.current.snap : null;
        return { ...s, offline: true, staleAt: s.data !== null && good ? good.savedAt : s.staleAt };
      });
    const onOnline = () => {
      setState((s) => ({ ...s, offline: false }));
      setNonce((n) => n + 1);
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
