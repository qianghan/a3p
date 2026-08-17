/**
 * Locale-aware formatters for currency, dates, and numbers.
 * All formatters respect tenant locale settings.
 */

/**
 * Format amount in cents to locale-aware currency string.
 * formatCurrency(4500, 'en-US', 'USD') -> "$45.00"
 * formatCurrency(4500, 'fr-CA', 'CAD') -> "45,00 $"
 */
export function formatCurrency(amountCents: number, locale: string, currency: string = 'USD'): string {
  const amount = amountCents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Currency code -> a sensible display locale for that currency's home market. */
const CURRENCY_LOCALES: Record<string, string> = {
  USD: 'en-US',
  CAD: 'en-CA',
  GBP: 'en-GB',
  AUD: 'en-AU',
  EUR: 'de-DE',
};

/**
 * Format amount in cents to a currency string, inferring a sensible display
 * locale from the currency code so call sites that only have a tenant's
 * `currency` field (not a separate locale) don't need to hardcode 'en-US'.
 * formatMoney(4500, 'AUD') -> "$45.00" (en-AU formatting)
 */
export function formatMoney(amountCents: number, currency: string = 'USD'): string {
  return formatCurrency(amountCents, CURRENCY_LOCALES[currency] ?? 'en-US', currency);
}

/** 'YYYY-MM-DD' with no time component. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format date to locale-aware string.
 * formatDate('2026-03-22', 'en-US') -> "Mar 22, 2026"
 * formatDate('2026-03-22', 'fr-CA') -> "2026-03-22"  (fr-CA is ISO-order)
 *
 * DATE-ONLY VALUES ARE FORMATTED IN UTC. This fixes a real, shipped bug:
 *
 *   new Date('2026-03-22')  is UTC midnight
 *   ...formatted in the LOCAL zone, in America/Vancouver (UTC-7),
 *      renders "Mar 21, 2026" — one day early.
 *
 * Every user west of UTC saw date-only values one day early. On an invoice due
 * date or a tax filing deadline that is a material error, not a cosmetic one.
 * CI masked it by running in UTC, and the package's own test asserted the
 * correct day, so the suite passed there and failed on any developer machine
 * in the Americas.
 *
 * A date-only string carries no zone, so the only reading that cannot shift is
 * to format it in the same zone it was parsed in — UTC. Values WITH a time
 * component are genuine instants and keep formatting in local time, which is
 * what a timestamp should do.
 */
export function formatDate(date: string | Date, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const isDateOnly = typeof date === 'string' && DATE_ONLY.test(date.trim());
  const d = typeof date === 'string' ? new Date(date) : date;
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  const opts: Intl.DateTimeFormatOptions = { ...(options || defaultOptions) };
  // Don't override an explicit caller-supplied zone.
  if (isDateOnly && opts.timeZone === undefined) opts.timeZone = 'UTC';
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/**
 * Format a LOGICAL DATE — a calendar day, not an instant.
 *
 * Always formats in UTC, so the rendered day never depends on where the viewer
 * is. Use this for due dates, filing deadlines, period boundaries, invoice
 * dates — anything a human would call "a date" rather than "a moment".
 *
 * WHY THIS IS SEPARATE FROM formatDate
 *
 * The two cases are indistinguishable from the value alone. Prisma `DateTime`
 * columns holding logical dates serialise to UTC midnight:
 *
 *     '2026-03-22T00:00:00.000Z'
 *
 * and that string is equally consistent with a real instant that happened at
 * midnight UTC. formatDate can only special-case the bare 'YYYY-MM-DD' shape;
 * for a full timestamp it must assume an instant and format locally, which in
 * America/Vancouver renders "Mar 21".
 *
 * Only the caller knows which meaning applies, so it has to say. Roughly 22
 * display sites were calling toLocaleDateString directly on due dates and
 * deadlines and showing the previous day to every viewer west of UTC — one of
 * them (the tax fast-track deadline) had already been patched with a local
 * `timeZone: 'UTC'` workaround, which is the same fix spelled out by hand.
 */
export function formatDateOnly(
  date: string | Date,
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  // timeZone is forced, not defaulted: a caller asking for a logical date and
  // also passing a zone is a contradiction, and honouring the zone would
  // reintroduce the shift this function exists to remove.
  const opts: Intl.DateTimeFormatOptions = { ...(options || defaultOptions), timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Format number with locale-aware separators.
 * formatNumber(1234.56, 'en-US') -> "1,234.56"
 * formatNumber(1234.56, 'fr-CA') -> "1 234,56"
 */
export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return value.toString();
  }
}

/**
 * Format percentage.
 * formatPercent(0.283, 'en-US') -> "28.3%"
 */
export function formatPercent(value: number, locale: string, decimals: number = 1): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${(value * 100).toFixed(decimals)}%`;
  }
}
