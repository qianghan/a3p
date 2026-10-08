'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Backstop: a waiter nobody reported is released after this long, so a missed
 * signal can never leave the pull indicator spinning (and the Refresh / Retry
 * controls busy) until the screen remounts.
 */
export const SETTLED_RELOAD_TIMEOUT_MS = 15_000;

export interface SettledReloadState {
  /** The data hook's loading || refreshing. */
  busy: boolean;
  data: unknown;
  error: unknown;
  staleAt: string | null;
}

type Outcome = Pick<SettledReloadState, 'data' | 'error' | 'staleAt'>;

/**
 * `reload()` only bumps a counter, so it settles before the request has even
 * started. This returns a promise that resolves when the load it starts has
 * finished, so the pull gesture's "Refreshing" spans the whole request instead
 * of flickering off at once.
 *
 * "Finished" is any of:
 *   - the data hook was seen busy and is idle again;
 *   - a new data / error / staleAt identity arrived while idle. When the
 *     request is a shared in-flight getHome() that answers in the same batch as
 *     the hook's busy=true update, React never commits busy=true — only the
 *     outcome shows that the load happened;
 *   - SETTLED_RELOAD_TIMEOUT_MS passed (backstop), or the screen unmounted.
 */
export function useSettledReload(reload: () => void, state: SettledReloadState): () => Promise<void> {
  const { busy, data, error, staleAt } = state;
  const waiters = useRef<Array<() => void>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawBusy = useRef(false);
  const startedWith = useRef<Outcome | null>(null);
  const latest = useRef(state);

  useEffect(() => {
    latest.current = state;
  });

  const release = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    sawBusy.current = false;
    startedWith.current = null;
    const done = waiters.current;
    waiters.current = [];
    done.forEach((resolve) => resolve());
  }, []);

  useEffect(() => {
    if (waiters.current.length === 0) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    const before = startedWith.current;
    const changed = before !== null && (before.data !== data || before.error !== error || before.staleAt !== staleAt);
    if (sawBusy.current || changed) release();
  }, [busy, data, error, staleAt, release]);

  // Unmounted mid-request: nobody will report the end, so release the callers and the timer.
  useEffect(() => release, [release]);

  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        const now = latest.current;
        if (startedWith.current === null) startedWith.current = { data: now.data, error: now.error, staleAt: now.staleAt };
        // Already mid-load: reload() restarts it, and its end is the edge we wait for.
        if (now.busy) sawBusy.current = true;
        if (timer.current === null) timer.current = setTimeout(release, SETTLED_RELOAD_TIMEOUT_MS);
        reload();
      }),
    [reload, release],
  );
}
