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

/**
 * Format date to locale-aware string.
 * formatDate('2026-03-22', 'en-US') -> "Mar 22, 2026"
 * formatDate('2026-03-22', 'fr-CA') -> "22 mars 2026"
 */
export function formatDate(date: string | Date, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  try {
    return new Intl.DateTimeFormat(locale, options || defaultOptions).format(d);
  } catch {
    return d.toLocaleDateString();
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
