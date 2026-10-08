/**
 * localStorage/sessionStorage access that never throws. Private windows,
 * blocked site data and full quotas all throw from the accessor itself; every
 * caller here stores a convenience (view mode, recents, nav list), so the
 * right failure is "behave as if nothing was stored".
 */
type Area = 'local' | 'session';

function area(a: Area): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return a === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(a: Area, key: string, fallback: T): T {
  try {
    const raw = area(a)?.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(a: Area, key: string, value: unknown): void {
  try {
    area(a)?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full — the value is a convenience only */
  }
}
