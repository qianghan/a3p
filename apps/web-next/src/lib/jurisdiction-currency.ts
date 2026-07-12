/**
 * Shared jurisdiction metadata — the single place the code/label/default-
 * currency mapping lives. Business Profile (Settings), the onboarding chat,
 * and the Tax Dashboard's read-only jurisdiction display all import this
 * instead of keeping their own local copies, which is exactly the kind of
 * duplication that let jurisdiction/currency drift out of sync across the
 * app before this consolidation.
 */

export interface JurisdictionOption {
  value: string;
  label: string;
  defaultCurrency: string;
}

export const JURISDICTION_OPTIONS: JurisdictionOption[] = [
  { value: 'us', label: '🇺🇸 United States', defaultCurrency: 'USD' },
  { value: 'ca', label: '🇨🇦 Canada', defaultCurrency: 'CAD' },
  { value: 'uk', label: '🇬🇧 United Kingdom', defaultCurrency: 'GBP' },
  { value: 'au', label: '🇦🇺 Australia', defaultCurrency: 'AUD' },
];

export function defaultCurrencyFor(jurisdiction: string | null | undefined): string {
  return JURISDICTION_OPTIONS.find((j) => j.value === jurisdiction)?.defaultCurrency ?? 'USD';
}

export function jurisdictionLabelFor(jurisdiction: string | null | undefined): string {
  return JURISDICTION_OPTIONS.find((j) => j.value === jurisdiction)?.label ?? jurisdiction ?? 'Unknown';
}

/**
 * Format a signed cents amount as a locale-aware currency string, e.g.
 * `formatCurrencyCents(-20000, 'CAD', 'en-CA')` -> "-CA$200". Falls back to
 * USD/en-US when the tenant hasn't configured a currency/locale yet (matches
 * the `AbTenantConfig` schema defaults). Centralizing this here — rather than
 * each page hardcoding a `$` prefix — is what keeps new UI jurisdiction/
 * currency-aware instead of USD-only.
 */
export function formatCurrencyCents(
  cents: number,
  currency?: string | null,
  locale?: string | null,
): string {
  const ccy = currency || 'USD';
  const loc = locale || 'en-US';
  try {
    return (cents / 100).toLocaleString(loc, {
      style: 'currency',
      currency: ccy,
      maximumFractionDigits: 0,
    });
  } catch {
    // Unknown/invalid locale or currency code — fall back to a safe default
    // rather than throwing and blanking the page.
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
  }
}
