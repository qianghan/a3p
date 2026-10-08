/**
 * localStorage prefix for the /app PWA's last-good screen snapshots.
 *
 * Lives under lib/ rather than app/app/_lib so the auth layer can clear the
 * snapshots without importing screen code.
 */
export const SNAPSHOT_PREFIX = 'ab:mobile:';

/**
 * Records which user the stored snapshots belong to. Deliberately outside
 * SNAPSHOT_PREFIX so a snapshot key can never collide with it.
 */
export const SNAPSHOT_OWNER_KEY = 'ab:mobile-owner';

/**
 * Fired on window after the stored snapshots are cleared, so a screen that is
 * already mounted can drop the snapshot it is showing from memory too.
 * A CustomEvent whose detail is `{ reason }` (see SnapshotClearReason).
 */
export const SNAPSHOT_CLEARED_EVENT = 'ab:mobile:cleared';

/**
 * Why the snapshots were cleared. 'unauthorized' means a request just got a
 * 401: the session is gone, so nobody should immediately refetch on its back.
 */
export type SnapshotClearReason = 'unauthorized' | 'session';

/** The reason carried by a SNAPSHOT_CLEARED_EVENT ('session' when absent). */
export function clearReasonOf(e: Event): SnapshotClearReason {
  const reason = (e as CustomEvent<{ reason?: unknown } | null>).detail?.reason;
  return reason === 'unauthorized' ? 'unauthorized' : 'session';
}

/**
 * public/sw.js stores every successful /api/v1/agentbook* GET in a Cache
 * Storage cache named `agentbook-api-vN` and serves it offline by URL alone —
 * it cannot tell whose data it is. Every one of them goes when the snapshots do.
 */
export const API_CACHE_PREFIX = 'agentbook-api-';

/** Fire-and-forget: delete the service worker's API caches. Never throws or rejects. */
function dropApiCaches(): void {
  try {
    if (typeof caches === 'undefined') return;
    const store = caches;
    void store
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(API_CACHE_PREFIX)).map((n) => store.delete(n))))
      .catch(() => {
        // Cache Storage unavailable or denied — nothing we can delete.
      });
  } catch {
    // `caches` accessor threw (insecure origin, blocked storage).
  }
}

/**
 * Remove every /app snapshot, and the service worker's API cache. Called on
 * logout, on an invalid session, and at the start of a login: a snapshot holds
 * the previous user's figures (client names, balances), and an offline screen
 * would otherwise show them to the next person who signs in on the same phone.
 */
export function clearMobileSnapshots(reason: SnapshotClearReason = 'session'): void {
  try {
    if (typeof window === 'undefined') return;
    const store = window.localStorage;
    const doomed: string[] = [SNAPSHOT_OWNER_KEY];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(SNAPSHOT_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Storage unavailable (private mode, blocked) — there is nothing to clear.
  }
  dropApiCaches();
  // Mounted screens hold copies in memory; tell them, even if the disk part failed.
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SNAPSHOT_CLEARED_EVENT, { detail: { reason } }));
  } catch {
    // Nobody to tell.
  }
}

/**
 * Bind the stored snapshots to `userId`. If they were saved for anyone else —
 * or for nobody we can name — they are dropped first. This covers every way a
 * different person can end up signed in without passing through logout or
 * login (register, OAuth, token hand-off, a session swapped server-side).
 */
export function claimMobileSnapshots(userId: string): void {
  try {
    if (typeof window === 'undefined' || !userId) return;
    const store = window.localStorage;
    if (store.getItem(SNAPSHOT_OWNER_KEY) === userId) return;
    clearMobileSnapshots();
    store.setItem(SNAPSHOT_OWNER_KEY, userId);
  } catch {
    // Storage unavailable — no snapshots can exist either.
  }
}
