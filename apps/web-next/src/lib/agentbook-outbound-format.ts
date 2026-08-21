import 'server-only';

/**
 * Money and date formatting for OUTBOUND messages — Telegram replies, the
 * morning digest, invoice emails.
 *
 * WHY THIS EXISTS
 *
 * These surfaces formatted every amount and date with a hardcoded 'en-US', and
 * several concatenated a literal '$'. So a French-Canadian or Australian user
 * received:
 *
 *     "$1,234.56"        where fr-CA reads    "1 234,56 $"
 *     "Mar 22, 2026"     where fr-CA reads    "22 mars 2026"
 *     "$1,234.56"        on a GBP account, mislabelling the CURRENCY
 *
 * That is worse than an untranslated button. A Telegram message is read outside
 * the app, often on a phone, and is frequently the only place a user sees a
 * figure — there is no surrounding UI to correct the impression, and no
 * language switcher to try.
 *
 * `AbTenantConfig` has carried `locale` (default 'en-US') alongside `currency`
 * and `timezone` the whole time. The server had the answer and did not ask.
 *
 * WHY NOT REUSE @agentbook/i18n's formatters
 *
 * `formatMoney(cents, currency)` INFERS a display locale from the currency
 * code, which is the fallback for call sites that have no locale. These call
 * sites do have one, and using the inference would reintroduce the bug in a
 * quieter form (CAD -> en-CA "$1,234.56" for a French reader). `formatCurrency`
 * would work, but it does not take a timezone, and outbound dates must render
 * in the tenant's zone or a due date lands on the wrong day.
 */

/** What every outbound formatter needs. Load once per message, not per field. */
export interface OutboundLocale {
  locale: string;
  currency: string;
  timezone: string;
}

/** Safe defaults, matching AbTenantConfig's own column defaults. */
export const OUTBOUND_FALLBACK: OutboundLocale = {
  locale: 'en-US',
  currency: 'USD',
  timezone: 'America/New_York',
};

/**
 * Build an OutboundLocale from an already-fetched tenant-config row.
 *
 * Takes the ROW rather than a Prisma client on purpose. Typing a client
 * parameter loosely enough for every caller's generated client turned into a
 * structural type that PrismaClient did not satisfy, and tightening it would
 * couple this module to a generated type it has no business knowing. Each
 * caller already queries abTenantConfig for currency or timezone; this just
 * reads what they fetched.
 *
 * Empty strings are treated as absent — a blank column is not a locale.
 */
export function resolveOutboundLocale(
  row: { locale?: string | null; currency?: string | null; timezone?: string | null } | null | undefined,
): OutboundLocale {
  return {
    locale: row?.locale || OUTBOUND_FALLBACK.locale,
    currency: row?.currency || OUTBOUND_FALLBACK.currency,
    timezone: row?.timezone || OUTBOUND_FALLBACK.timezone,
  };
}

/**
 * Money, in the tenant's currency and locale.
 *
 * The currency argument overrides the tenant default for genuinely
 * multi-currency records — an invoice raised in EUR by a CAD tenant is a EUR
 * invoice, and must not be relabelled.
 */
export function outMoney(cents: number, loc: OutboundLocale, currency?: string): string {
  const cur = currency || loc.currency;
  try {
    return new Intl.NumberFormat(loc.locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // An unknown currency code throws rather than degrading. Show the code —
    // "EUR 12.34" is unambiguous, where a bare number is not.
    return `${cur} ${(cents / 100).toFixed(2)}`;
  }
}

/** Money with the cents dropped when the amount is whole, for terse summaries. */
export function outMoneyCompact(cents: number, loc: OutboundLocale, currency?: string): string {
  const cur = currency || loc.currency;
  try {
    return new Intl.NumberFormat(loc.locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${cur} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * A calendar DATE — a due date, a filing deadline, an expense date.
 *
 * Rendered in the tenant's timezone. Without that, a date stored as UTC
 * midnight renders as the previous day for every tenant west of UTC, which on
 * a due date is a material error rather than a cosmetic one.
 */
export function outDate(
  date: string | Date,
  loc: OutboundLocale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat(loc.locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: loc.timezone,
      ...options,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** A plain number (hours, counts) in the tenant's locale. */
export function outNumber(
  value: number,
  loc: OutboundLocale,
  options?: Intl.NumberFormatOptions,
): string {
  try {
    return new Intl.NumberFormat(loc.locale, options).format(value);
  } catch {
    return String(value);
  }
}
