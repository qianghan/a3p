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
