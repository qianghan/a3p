'use client';

import { useEffect, useState } from 'react';
import type { MobileHome } from '@/lib/mobile/types';
import { clearMobileSnapshots, clearReasonOf } from '@/lib/mobile/snapshot-keys';
import { ApiError, getHome } from './api';
import {
  readSnapshot,
  writeSnapshot,
  SNAPSHOT_EVENT,
  SNAPSHOT_PREFIX,
  SNAPSHOT_CLEARED_EVENT,
  type Snapshot,
} from './useMobileData';

/** The useMobileData key the Home screen uses; the shell reads the same snapshot. */
export const HOME_KEY = 'home';

/**
 * A home snapshot older than this is shown at once AND revalidated. Without a
 * TTL the badges froze: the shell only fetched when no snapshot existed, so a
 * reviewed document or a paid invoice kept its badge until sign-out.
 */
export const BADGE_MAX_AGE_MS = 2 * 60 * 1000;

export interface ShellBadges {
  homeCritical: boolean;
  docsNeedsReview: number;
}

const NONE: ShellBadges = { homeCritical: false, docsNeedsReview: 0 };

export function badgesFrom(home: MobileHome | null): ShellBadges {
  if (!home || !Array.isArray(home.alerts)) return NONE;
  const homeCritical = home.alerts.some((a) => a.severity === 'critical');
  const review = home.alerts.find((a) => a.kind === 'review_needed');
  const n = Number(review?.params?.count ?? 0);
  return { homeCritical, docsNeedsReview: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 };
}

/** No snapshot, or one saved longer than BADGE_MAX_AGE_MS ago (or "in the future": the clock moved). */
export function isBadgeSnapshotStale(snap: Snapshot<unknown> | null, now: number = Date.now()): boolean {
  if (!snap) return true;
  const age = now - Date.parse(snap.savedAt);
  return !(age >= 0 && age <= BADGE_MAX_AGE_MS);
}

function online(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * Tab badges from the cached Home data, stale-while-revalidate.
 *
 * The snapshot is shown immediately. When it is missing or older than
 * BADGE_MAX_AGE_MS — on mount, and again whenever the page becomes visible —
 * the shared getHome() runs (one request; on the Home screen it is the
 * screen's own in-flight request). Success writes the snapshot through the
 * normal write path; a failure keeps the old one.
 *
 * The badges are the signed-in user's figures, so they live and die with the
 * snapshot: a clear (sign-out, a different user, a 401 anywhere in /app) or a
 * cross-tab removal drops them, and a response that lands after one is thrown
 * away rather than written back under the next session — then asked for once
 * more under the current one, unless the clear came from a 401.
 */
export function useShellBadges(): ShellBadges {
  const [badges, setBadges] = useState<ShellBadges>(NONE);

  useEffect(() => {
    let cancelled = false;
    // Bumped on every clear; a fetch started under an older generation is stale.
    let generation = 0;
    let inFlight = false;
    // A 401 was seen (here or anywhere): do not retry a discarded response.
    let unauthorized = false;

    const refresh = () => {
      const snap = readSnapshot<MobileHome>(HOME_KEY);
      if (!cancelled) setBadges(badgesFrom(snap?.data ?? null));
      return snap;
    };

    const revalidate = (retryIfDiscarded: boolean) => {
      if (cancelled || inFlight || !online()) return;
      inFlight = true;
      const startedAt = generation;
      getHome()
        .then((home) => {
          inFlight = false;
          if (cancelled) return;
          if (generation === startedAt) {
            unauthorized = false;
            writeSnapshot(HOME_KEY, home);
          } else if (retryIfDiscarded && !unauthorized) {
            // Discarded because of a clear: ask once more, under the session there is now.
            revalidate(false);
          }
        })
        .catch((err: unknown) => {
          inFlight = false;
          // Same rule as useMobileData: the session is gone, so is whatever was stored for it.
          if (err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')) {
            unauthorized = true;
            clearMobileSnapshots('unauthorized');
          }
          // Otherwise badges are a hint; a failure keeps the last snapshot rather than erroring.
        });
    };

    if (isBadgeSnapshotStale(refresh())) revalidate(true);

    const onSnapshot = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === HOME_KEY) refresh();
    };
    const onCleared = (e: Event) => {
      generation += 1;
      if (clearReasonOf(e) === 'unauthorized') unauthorized = true;
      refresh();
    };
    const onStorage = (e: StorageEvent) => {
      // key === null: another tab called localStorage.clear().
      if (e.key !== null && e.key !== SNAPSHOT_PREFIX + HOME_KEY) return;
      // Another tab removed it (signed out): anything in flight here is the old session's.
      if (e.key === null || e.newValue === null) generation += 1;
      refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (isBadgeSnapshotStale(readSnapshot<MobileHome>(HOME_KEY))) revalidate(true);
    };
    window.addEventListener(SNAPSHOT_EVENT, onSnapshot);
    window.addEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener(SNAPSHOT_EVENT, onSnapshot);
      window.removeEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return badges;
}
