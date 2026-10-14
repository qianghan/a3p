/**
 * localStorage/sessionStorage access that never throws. Private windows,
 * blocked site data and full quotas all throw from the accessor itself; every
 * caller here stores a convenience (view mode, recents, nav list), so the
 * right failure is "behave as if nothing was stored".
 *
 * Every access goes through the try blocks in readJson / writeJson / removeJson
 * (including the window.localStorage accessor), so there is no separate guard.
 */
type Area = 'local' | 'session';

function area(a: Area): Storage | null {
  if (typeof window === 'undefined') return null;
  return a === 'local' ? window.localStorage : window.sessionStorage;
}

export function readJson<T>(a: Area, key: string, fallback: T): T {
  try {
    const raw = area(a)?.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Returns false when the value could not be stored (storage unavailable or full). */
export function writeJson(a: Area, key: string, value: unknown): boolean {
  try {
    const store = area(a);
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage unavailable or full — the value is a convenience only
  }
}

export function removeJson(a: Area, key: string): void {
  try {
    area(a)?.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}
