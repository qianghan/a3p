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
 */
export const SNAPSHOT_CLEARED_EVENT = 'ab:mobile:cleared';

/**
 * Remove every /app snapshot. Called on logout, on an invalid session, and at
 * the start of a login: a snapshot holds the previous user's figures (client
 * names, balances), and an offline screen would otherwise show them to the
 * next person who signs in on the same phone.
 */
export function clearMobileSnapshots(): void {
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
  // Mounted screens hold copies in memory; tell them, even if the disk part failed.
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SNAPSHOT_CLEARED_EVENT));
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
