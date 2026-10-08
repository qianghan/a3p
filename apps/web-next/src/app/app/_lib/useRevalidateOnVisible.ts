'use client';

import { useEffect, useRef } from 'react';

export interface RevalidateOnVisibleState {
  /** What is on screen; nothing on screen (loading, error, signed out) → never auto-reload. */
  hasData: boolean;
  /** True only for data that came from a successful load just now (not a snapshot fallback). */
  live: boolean;
  /** The data hook's loading || refreshing. */
  busy: boolean;
}

function online(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * Reload when the page becomes visible again and the last successful load is
 * older than `maxAgeMs`.
 *
 * An installed PWA resumes in place: without this, a screen mounted hours ago
 * shows hours-old numbers as live (no "as of" notice — they were live when
 * fetched) while the tab bar's dot, which revalidates on the same trigger,
 * shows today's. Only with data on screen: an error or signed-out state keeps
 * its own Retry / Sign-in instead of refetching on every resume.
 */
export function useRevalidateOnVisible(reload: () => void, state: RevalidateOnVisibleState, maxAgeMs: number): void {
  const { hasData, live, busy } = state;
  /** When the data on screen was last loaded live; null = never (only a snapshot so far). */
  const loadedAt = useRef<number | null>(null);
  const latest = useRef({ reload, hasData, busy });

  useEffect(() => {
    latest.current = { reload, hasData, busy };
  });

  useEffect(() => {
    if (live && !busy) loadedAt.current = Date.now();
  }, [live, busy]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const { reload: run, hasData: shown, busy: loading } = latest.current;
      if (!shown || loading || !online()) return;
      const at = loadedAt.current;
      const age = at === null ? Infinity : Date.now() - at;
      // Negative age: the clock moved backwards — treat as stale.
      if (age >= 0 && age <= maxAgeMs) return;
      run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [maxAgeMs]);
}
