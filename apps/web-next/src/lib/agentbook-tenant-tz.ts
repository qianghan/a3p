/**
 * Tenant-timezone-aware date helpers (G-025 / PR 20).
 *
 * The audit (Stream A.1 / A.2) flagged multiple sites where financial dates
 * were constructed via `new Date(dateString)` — which interprets bare
 * "YYYY-MM-DD" inputs as UTC midnight. For a tenant in Asia-Pacific posting
 * an expense on Mar 31, the resulting timestamp could land on Apr 1 UTC
 * and grouping by month would put the row in the wrong fiscal period.
 *
 * This module centralizes the conversion: a date string supplied by the
 * user is interpreted as midnight in the TENANT'S timezone, then converted
 * to UTC for storage. Period bucketing also resolves through the tenant's
 * TZ so reports group by the user's calendar, not the server's.
 *
 * Implementation uses native Intl.DateTimeFormat — zero new dependencies.
 */

import 'server-only';

/**
 * Convert a user-supplied date string to a UTC Date, interpreting bare
 * "YYYY-MM-DD" inputs as midnight in the tenant's local timezone.
 *
 * - "YYYY-MM-DD"           → midnight tenant-local → UTC instant
 * - "YYYY-MM-DDTHH:MM:SSZ" → returned as-is (already absolute)
 * - "YYYY-MM-DDTHH:MM:SS"  → interpreted as tenant-local wall-clock time
 *                            → UTC instant
 * - any other input        → falls back to `new Date(input)` (best-effort)
 *
 * `timezone` must be an IANA name like 'America/New_York' or 'Asia/Tokyo'.
 * Invalid names fall back to UTC.
 */
export function tenantLocalDateToUtc(input: string | Date, timezone: string): Date {
  if (input instanceof Date) return input;
  const s = String(input).trim();

  // Date-only: "YYYY-MM-DD"
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return localWallClockToUtc(Number(y), Number(mo), Number(d), 0, 0, 0, timezone);
  }

  // Wall-clock without explicit offset: "YYYY-MM-DDTHH:MM(:SS)?"
  const wall = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (wall) {
    const [, y, mo, d, h, mi, se] = wall;
    return localWallClockToUtc(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      se ? Number(se) : 0,
      timezone,
    );
  }

  // Absolute (has Z or numeric offset) — pass through.
  return new Date(s);
}

/**
 * Return the calendar period key (YYYY-MM) for a Date as seen in the
 * tenant's timezone. Use this for period grouping in P&L / fiscal close /
 * any "what month did this happen in" query.
 */
export function tenantPeriodKey(date: Date, timezone: string): string {
  const fmt = formatterFor(timezone);
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}

/**
 * Return YYYY-MM-DD in the tenant's local calendar for a Date.
 * Useful for "today" / "yesterday" comparisons and display.
 */
export function tenantLocalDateKey(date: Date, timezone: string): string {
  const fmt = formatterFor(timezone);
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

// ─── Internals ────────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    // Invalid timezone (e.g., typo) — fall back to UTC so we never throw.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  formatterCache.set(timezone, f);
  return f;
}

/**
 * Convert a tenant-local wall-clock time (year/month/day/hour/minute/second)
 * to the corresponding UTC instant.
 *
 * Strategy: tentatively treat the wall-clock as UTC, then look up what
 * Intl says that UTC instant is in the tenant's TZ, compute the delta,
 * and apply it. One round-trip refinement handles DST edge cases.
 */
function localWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  se: number,
  timezone: string,
): Date {
  // First guess: treat the wall-clock as UTC.
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  // Look up the wall-clock that Intl reports for this UTC instant in `timezone`.
  const offsetMs = utcOffsetAtInstant(guess, timezone);
  // The wall-clock we WANT minus the wall-clock Intl reports gives the
  // adjustment. Equivalent to "subtract the offset" in clock-time direction.
  guess = new Date(guess.getTime() - offsetMs);
  // One refinement pass to handle DST boundaries (rare).
  const refinedOffset = utcOffsetAtInstant(guess, timezone);
  if (refinedOffset !== offsetMs) {
    guess = new Date(guess.getTime() + (offsetMs - refinedOffset));
  }
  return guess;
}

/**
 * Returns the offset (in ms) between UTC and `timezone` at the given instant.
 *
 * Positive when the tenant TZ is AHEAD of UTC (e.g. Asia/Tokyo: +32400000ms),
 * negative when behind (e.g. America/New_York EST: -18000000ms).
 */
function utcOffsetAtInstant(instant: Date, timezone: string): number {
  const fmt = formatterFor(timezone);
  const parts = fmt.formatToParts(instant);
  const obj: Record<string, string> = {};
  for (const p of parts) obj[p.type] = p.value;
  // Intl returns "24" for midnight on some platforms; normalize.
  const hour = obj.hour === '24' ? '00' : obj.hour;
  const tzWallClockMs = Date.UTC(
    Number(obj.year),
    Number(obj.month) - 1,
    Number(obj.day),
    Number(hour),
    Number(obj.minute),
    Number(obj.second),
  );
  return tzWallClockMs - instant.getTime();
}
