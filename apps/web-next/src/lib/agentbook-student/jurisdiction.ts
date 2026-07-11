/**
 * Shared jurisdiction → country-name mapping for the Student Success
 * plugins (Scholarship, Career). Centralized so a grounded-search prompt
 * never silently collapses an unrecognized jurisdiction into "the United
 * States" — that was the root cause of UK/AU students (and, when
 * jurisdiction was simply never set, effectively everyone) getting
 * US-biased search results.
 */

export const JURISDICTION_COUNTRY_NAMES: Record<string, string> = {
  us: 'the United States',
  ca: 'Canada',
  uk: 'the United Kingdom',
  au: 'Australia',
};

export function countryNameFor(jurisdiction: string | null | undefined): string {
  if (!jurisdiction) return 'the United States';
  return JURISDICTION_COUNTRY_NAMES[jurisdiction.toLowerCase()] ?? 'the United States';
}
