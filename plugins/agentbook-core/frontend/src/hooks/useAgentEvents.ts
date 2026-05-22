/**
 * useAgentEvents — React hook that polls the /events/since endpoint and
 * notifies subscribers when new agent-driven events occur (G-033 / PR 28).
 *
 * Usage:
 *   const { lastChange, kinds } = useAgentEvents();
 *   useEffect(() => { refetch(); }, [lastChange]);
 *
 * Or filtered by event type:
 *   const { lastChange } = useAgentEvents({ kinds: ['expense.created', 'expense.confirmed'] });
 *
 * Polls every 10s by default (configurable). Tracks the latest event
 * timestamp seen and increments `lastChange` whenever a newer event
 * arrives. Components mount + listen + refetch.
 *
 * Pauses polling when the document is hidden (visibility API) to avoid
 * burning battery on backgrounded tabs.
 */

import { useEffect, useRef, useState } from 'react';

const DEFAULT_INTERVAL_MS = 10_000;
const API = '/api/v1/agentbook-core/events/since';

interface EventsSinceResponse {
  latestAt: string | null;
  count: number;
  kinds: Record<string, number>;
}

export interface UseAgentEventsOptions {
  /** Poll interval in ms. Defaults to 10s. */
  intervalMs?: number;
  /**
   * If provided, only bump `lastChange` when at least one of these event
   * types appears in the response. Useful for pages that only care about a
   * specific entity (e.g., expenses page filters to `expense.*`).
   */
  kinds?: string[];
  /** Disable polling entirely (e.g., during tests). */
  disabled?: boolean;
}

export interface UseAgentEventsResult {
  /**
   * Increments whenever a new event matching the filter arrives. Watch this
   * in `useEffect` deps to trigger refetches.
   */
  lastChange: number;
  /** Map of event-type → count from the most recent poll. */
  kinds: Record<string, number>;
  /** Latest event timestamp seen (ISO). */
  latestAt: string | null;
}

export function useAgentEvents(opts: UseAgentEventsOptions = {}): UseAgentEventsResult {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const wantedKinds = opts.kinds;
  const disabled = opts.disabled ?? false;

  const [state, setState] = useState<UseAgentEventsResult>({
    lastChange: 0,
    kinds: {},
    latestAt: null,
  });
  const sinceRef = useRef<string>(new Date().toISOString());
  const aliveRef = useRef(true);

  useEffect(() => {
    if (disabled) return;
    aliveRef.current = true;

    async function poll() {
      try {
        const res = await fetch(`${API}?ts=${encodeURIComponent(sinceRef.current)}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as EventsSinceResponse;
        if (!aliveRef.current) return;

        // Did any event arrive that matches our filter?
        let matched = data.count > 0;
        if (matched && wantedKinds && wantedKinds.length > 0) {
          matched = Object.keys(data.kinds).some((k) =>
            wantedKinds.some((w) => k === w || k.startsWith(`${w}.`)),
          );
        }

        if (matched && data.latestAt) {
          sinceRef.current = data.latestAt;
          setState((prev) => ({
            lastChange: prev.lastChange + 1,
            kinds: data.kinds,
            latestAt: data.latestAt,
          }));
        } else if (data.latestAt) {
          // Still advance the cursor so we don't keep re-fetching the same window.
          sinceRef.current = data.latestAt;
        }
      } catch {
        // Network blip — keep polling.
      }
    }

    let interval: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (interval !== null) return;
      // Fire immediately so the first refresh is fast.
      void poll();
      interval = setInterval(poll, intervalMs);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    function handleVisibility() {
      if (document.hidden) stop();
      else start();
    }

    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      aliveRef.current = false;
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // Re-run if interval or filter list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, disabled, wantedKinds?.join(',')]);

  return state;
}
