/**
 * Best-effort parsing of the free-text deadline the model returns
 * (`deadlineText`, e.g. "March 1, 2027", "Rolling", "Varies by program") into
 * a comparable date, so expired listings can be filtered out. Only ever
 * excludes results with a genuinely parseable PAST date — "Rolling",
 * "Ongoing", or any text that isn't a real date, is never filtered, since
 * that's a legitimate answer, not an expired one.
 */

/**
 * Parse a free-text deadline into a Date, or null if it isn't a real,
 * unambiguous date (e.g. "Rolling", "Varies", "TBD", empty, or malformed).
 */
export function parseDeadline(text: string | null | undefined): Date | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Has this deadline passed, compared to `now`? Compares calendar dates (not
 * time-of-day) so a deadline of "today" is never treated as already passed.
 * A `null` deadline (unparseable or not provided) is never "passed" — there's
 * nothing to filter on.
 */
export function isDeadlinePassed(deadline: Date | null, now: Date): boolean {
  if (!deadline) return false;
  const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return deadlineDay.getTime() < today.getTime();
}
