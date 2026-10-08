/**
 * Pure (no server-only, no Prisma): shared by POST /expenses/from-receipt and
 * PUT/PATCH /expenses/[id].
 */

/** A real YYYY-MM-DD calendar date. new Date('2026-02-31') would silently roll over to 3 March. */
export function isIsoCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
