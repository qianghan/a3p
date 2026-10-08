'use client';

import { useEffect, useState } from 'react';
import type { MobileHome } from '@/lib/mobile/types';
import { clearMobileSnapshots } from '@/lib/mobile/snapshot-keys';
import { ApiError, getHome } from './api';
import { readSnapshot, writeSnapshot, SNAPSHOT_EVENT, SNAPSHOT_PREFIX, SNAPSHOT_CLEARED_EVENT } from './useMobileData';

/** The useMobileData key the Home screen uses; the shell reads the same snapshot. */
export const HOME_KEY = 'home';

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

function online(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * Tab badges from the cached Home data. One getHome() at most, only when no
 * snapshot exists yet — and on the Home screen that call shares the screen's
 * own in-flight request.
 *
 * The badges are the signed-in user's figures, so they live and die with the
 * snapshot: a clear (sign-out, a different user, a 401 anywhere in /app) or a
 * cross-tab removal drops them, and a response that lands after a clear is
 * thrown away rather than written back under the next session.
 */
export function useShellBadges(): ShellBadges {
  const [badges, setBadges] = useState<ShellBadges>(NONE);

  useEffect(() => {
    let cancelled = false;
    // Bumped on every clear; a fetch started under an older generation is stale.
    let generation = 0;
    const refresh = () => {
      const snap = readSnapshot<MobileHome>(HOME_KEY);
      if (!cancelled) setBadges(badgesFrom(snap?.data ?? null));
      return snap;
    };

    if (!refresh() && online()) {
      const startedAt = generation;
      getHome()
        .then((home) => {
          if (!cancelled && generation === startedAt) writeSnapshot(HOME_KEY, home);
        })
        .catch((err: unknown) => {
          // Same rule as useMobileData: the session is gone, so is whatever was stored for it.
          if (err instanceof ApiError && (err.status === 401 || err.code === 'unauthorized')) {
            clearMobileSnapshots();
          }
          // Otherwise badges are a hint; a failed fetch leaves them off rather than erroring.
        });
    }

    const onSnapshot = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === HOME_KEY) refresh();
    };
    const onCleared = () => {
      generation += 1;
      refresh();
    };
    const onStorage = (e: StorageEvent) => {
      // key === null: another tab called localStorage.clear().
      if (e.key === null || e.key === SNAPSHOT_PREFIX + HOME_KEY) refresh();
    };
    window.addEventListener(SNAPSHOT_EVENT, onSnapshot);
    window.addEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
    window.addEventListener('storage', onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener(SNAPSHOT_EVENT, onSnapshot);
      window.removeEventListener(SNAPSHOT_CLEARED_EVENT, onCleared);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return badges;
}
