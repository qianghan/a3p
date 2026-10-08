'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { SNAPSHOT_PREFIX, SNAPSHOT_CLEARED_EVENT, clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';

export { SNAPSHOT_PREFIX, SNAPSHOT_CLEARED_EVENT };

/** At most this many snapshots are kept per key family (`docs:` for `docs:<query>`). */
export const SNAPSHOT_FAMILY_CAP = 8;

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

/**
 * Keys that embed free text (`docs:<search>`) would otherwise leave one
 * snapshot per keystroke. Keep the most recently written few per family.
 */
function evictOldestInFamily(key: string): void {
  const colon = key.indexOf(':');
  if (colon < 0) return;
  const familyPrefix = SNAPSHOT_PREFIX + key.slice(0, colon + 1);
  const own = SNAPSHOT_PREFIX + key;
  const store = window.localStorage;
  const members: { storageKey: string; at: number }[] = [];
  for (let i = 0; i < store.length; i++) {
    const storageKey = store.key(i);
    if (!storageKey || !storageKey.startsWith(familyPrefix)) continue;
    let at = 0;
    try {
      const t = Date.parse((JSON.parse(store.getItem(storageKey) ?? 'null') as { savedAt?: string } | null)?.savedAt ?? '');
      at = Number.isNaN(t) ? 0 : t;
    } catch {
      at = 0;
    }
    members.push({ storageKey, at });
  }
  if (members.length <= SNAPSHOT_FAMILY_CAP) return;
  members
    .filter((m) => m.storageKey !== own)
    .sort((a, b) => a.at - b.at)
    .slice(0, members.length - SNAPSHOT_FAMILY_CAP)
    .forEach((m) => store.removeItem(m.storageKey));
}

export function writeSnapshot<T>(key: string, data: T, savedAt: string = new Date().toISOString()): void {
  try {
    window.localStorage.setItem(SNAPSHOT_PREFIX + key, JSON.stringify({ data, savedAt }));
    evictOldestInFamily(key);
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

interface KeyedState<T> extends MobileDataState<T> {
  /** The key this state was produced for. */
  key: string;
}

function initialState<T>(key: string): KeyedState<T> {
  return { key, data: null, error: null, loading: true, refreshing: false, offline: false, staleAt: null };
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
  const [state, setState] = useState<KeyedState<T>>(() => initialState<T>(key));
  // State that belongs to a different key (a Docs filter chip just changed) is
  // never shown under the new one: render the reset state straight away.
  const view = state.key === key ? state : initialState<T>(key);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    const good = lastGood.current?.key === key ? lastGood.current.snap : null;
    setState((s) => {
      const base = s.key === key ? s : initialState<T>(key);
      return { ...base, loading: good === null && base.data === null, refreshing: good !== null || base.data !== null, error: null };
    });

    fetcherRef.current().then(
      (data) => {
        if (cancelled) return;
        const savedAt = new Date().toISOString();
        lastGood.current = { key, snap: { data, savedAt } };
        writeSnapshot(key, data, savedAt);
        setState({ key, data, error: null, loading: false, refreshing: false, offline: false, staleAt: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')) {
          // The session is gone: whatever is stored belongs to whoever held it.
          lastGood.current = null;
          clearMobileSnapshots('unauthorized');
          setState({ key, data: null, error, loading: false, refreshing: false, offline: false, staleAt: null });
          return;
        }
        const offline = !browserOnline() || isConnectivityError(err);
        const fallback = (lastGood.current?.key === key ? lastGood.current.snap : null) ?? readSnapshot<T>(key);
        if (fallback) lastGood.current = { key, snap: fallback };
        setState({
          key,
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
    // Snapshots were wiped (sign-out, another user): forget the in-memory copy,
    // and drop what is on screen only if it IS a snapshot — live data stays.
    const onCleared = () => {
      lastGood.current = null;
      setState((s) =>
        s.staleAt === null
          ? s
          : { ...s, data: null, staleAt: null, error: s.error ?? new ApiError('snapshot_cleared', 0, 'snapshot_cleared') },
      );
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
    };
  }, [key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const { key: _stateKey, ...publicState } = view;
  void _stateKey;
  return { ...publicState, reload };
}
