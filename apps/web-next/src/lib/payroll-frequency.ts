/**
 * Pay frequency — market display labels and draft pay-period math (PR 4c, spec §5.5).
 *
 * Stored values never change (weekly | biweekly | semimonthly | monthly); only
 * the label does: AU calls biweekly "Fortnightly", US/CA "Bi-weekly". The map
 * lives in the web catalog (core_ui) AND the chat reply catalog (agent).
 *
 * Dates are DATE-ONLY strings (YYYY-MM-DD) and all arithmetic is done in UTC
 * (Date.UTC), so a DST change can never shift a period by a day.
 */

export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export type PayFrequency = typeof PAY_FREQUENCIES[number];

export function isPayFrequency(v: unknown): v is PayFrequency {
  return typeof v === 'string' && (PAY_FREQUENCIES as readonly string[]).includes(v);
}

const LABEL_SEGMENT: Record<PayFrequency, string> = {
  weekly: 'weekly', biweekly: 'bi_weekly', semimonthly: 'semi_monthly', monthly: 'monthly',
};

/** Catalog key for a frequency's label in a market. `ns` = 'core_ui' (web) or 'agent' (chat replies). */
export function frequencyLabelKey(frequency: string, jurisdiction: string, ns: 'core_ui' | 'agent' = 'core_ui'): string {
  if (frequency === 'biweekly' && jurisdiction === 'au') return `${ns}.fortnightly`;
  const seg = isPayFrequency(frequency) ? LABEL_SEGMENT[frequency] : 'bi_weekly';
  return `${ns}.${seg}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(iso: string): { y: number; m: number; d: number; ms: number } {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`invalid date: ${iso}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error(`invalid date: ${iso}`);
  return { y, m: mo, d, ms };
}

function fmt(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
const DAY = 86_400_000;

export function addDaysIso(iso: string, days: number): string { return fmt(parseIso(iso).ms + days * DAY); }

/** UTC calendar date of a stored DateTime (Prisma stores date-only values at 00:00Z). */
export function toIsoDate(v: Date | string): string { return (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10); }

function lastDayOfMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const pad = (n: number) => String(n).padStart(2, '0');

export interface PayPeriod { periodStart: string; periodEnd: string; payDate: string }

/**
 * The draft pay period for `asOf`:
 * - weekly / biweekly: the 7 / 14-day cycle from `anchor` containing asOf
 *   (anchor required); an anchor after asOf makes the first period start ON the anchor.
 * - semimonthly: 1st–15th or 16th–last day of asOf's month.
 * - monthly: asOf's calendar month.
 * For the calendar frequencies a future anchor moves asOf up to the anchor.
 * payDate defaults to the period end (no pay-lag setting exists yet).
 */
export function payPeriodFor(frequency: PayFrequency, anchor: string | null, asOf: string): PayPeriod {
  if (!isPayFrequency(frequency)) throw new Error(`unknown pay frequency: ${String(frequency)}`);
  const at = parseIso(asOf);
  const anc = anchor ? parseIso(anchor) : null;
  let start: string, end: string;
  if (frequency === 'weekly' || frequency === 'biweekly') {
    if (!anc) throw new Error(`${frequency} pay periods need an anchor date`);
    const len = frequency === 'weekly' ? 7 : 14;
    const n = at.ms < anc.ms ? 0 : Math.floor((at.ms - anc.ms) / DAY / len);
    const s = anc.ms + n * len * DAY;
    start = fmt(s); end = fmt(s + (len - 1) * DAY);
  } else {
    const ref = anc && anc.ms > at.ms ? anc : at;
    const last = lastDayOfMonth(ref.y, ref.m);
    const ym = `${ref.y}-${pad(ref.m)}`;
    if (frequency === 'monthly') { start = `${ym}-01`; end = `${ym}-${pad(last)}`; }
    else if (ref.d <= 15) { start = `${ym}-01`; end = `${ym}-15`; }
    else { start = `${ym}-16`; end = `${ym}-${pad(last)}`; }
  }
  return { periodStart: start, periodEnd: end, payDate: end };
}

/** Draft runs are generated per group: cycle frequencies also split by anchor. */
export function groupKey(frequency: string, anchor: string | null): string {
  return frequency === 'weekly' || frequency === 'biweekly' ? `${frequency}|${anchor ?? ''}` : frequency;
}
