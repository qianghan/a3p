/**
 * The tax year a restatement acts on (PR 2c, spec §5.1) — ONE definition for
 * the route default, the Settings card and chat (review I-1 / M-3).
 *
 *   AU: the 1 Jul – 30 Jun income year, named by the year it ENDS in
 *       (2026 = 1 Jul 2025 – 30 Jun 2026; "2025–2026", "2025-26", "FY2026",
 *       "FY2025-26" all mean 2026).
 *   everyone else: the calendar year.
 *
 * "Today" is a DATE in the tenant's time zone, not a UTC instant, so 1 Jul in
 * Sydney is already the new AU year even while UTC is still on 30 Jun.
 * A leaf module (no imports) on purpose.
 */

export interface TaxYearBounds {
  year: number;
  from: Date;
  toExclusive: Date;
  /** First day, YYYY-MM-DD. */
  fromIso: string;
  /** Last day (inclusive), YYYY-MM-DD. */
  toIso: string;
}

const isAu = (j: string | null | undefined) => (j ?? '').toLowerCase() === 'au';
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function taxYearBounds(jurisdiction: string | null | undefined, year: number): TaxYearBounds {
  const from = isAu(jurisdiction) ? new Date(Date.UTC(year - 1, 6, 1)) : new Date(Date.UTC(year, 0, 1));
  const toExclusive = isAu(jurisdiction) ? new Date(Date.UTC(year, 6, 1)) : new Date(Date.UTC(year + 1, 0, 1));
  return { year, from, toExclusive, fromIso: iso(from), toIso: iso(new Date(toExclusive.getTime() - 86_400_000)) };
}

/** The tax year a calendar date (YYYY-MM-DD) falls in. */
export function taxYearOfDate(jurisdiction: string | null | undefined, dateIso: string): number {
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7));
  return isAu(jurisdiction) && m >= 7 ? y + 1 : y;
}

const FALLBACK_ZONE: Record<string, string> = { au: 'Australia/Sydney', ca: 'America/Toronto', uk: 'Europe/London', us: 'America/New_York' };

/**
 * The zone "today" is read in. AbTenantConfig.timezone defaults to
 * America/New_York for everyone, so for a non-US tenant that default is
 * treated as "not set" and the jurisdiction's main zone is used.
 */
export function taxYearZone(jurisdiction: string | null | undefined, timeZone?: string | null): string {
  const j = (jurisdiction ?? 'us').toLowerCase();
  const tz = timeZone && !(timeZone === 'America/New_York' && j !== 'us') ? timeZone : FALLBACK_ZONE[j] ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_ZONE[j] ?? 'UTC';
  }
}

/** Today's date (YYYY-MM-DD) in a zone. */
export function localDateIso(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The tax year containing today in the tenant's zone. */
export function currentTaxYear(jurisdiction: string | null | undefined, now: Date = new Date(), timeZone?: string | null): number {
  return taxYearOfDate(jurisdiction, localDateIso(now, taxYearZone(jurisdiction, timeZone)));
}

/**
 * The tax year a sentence names, or null. AU: a range ("2025–2026",
 * "2025-26", "2025/26", "FY2025-26") is the year it ENDS in; "FY2026" /
 * "FY26" is 2026; a lone year is that year. Others: the first year named.
 */
export function taxYearFromText(text: string, jurisdiction: string | null | undefined): number | null {
  const s = text || '';
  if (isAu(jurisdiction)) {
    const range = /(?<!\d)(20\d{2})\s*[-–—/]\s*(20\d{2}|\d{2})\b/.exec(s);
    if (range) {
      const start = Number(range[1]);
      const end = range[2].length === 2 ? Math.floor(start / 100) * 100 + Number(range[2]) : Number(range[2]);
      if (end === start + 1) return end;
    }
    const fy = /\bFY\s?(20\d{2}|\d{2})\b/i.exec(s);
    if (fy) return fy[1].length === 2 ? 2000 + Number(fy[1]) : Number(fy[1]);
  }
  const m = /\b(20\d{2})\b/.exec(s);
  return m ? Number(m[1]) : null;
}
