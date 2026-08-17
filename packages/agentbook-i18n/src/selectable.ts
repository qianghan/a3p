/**
 * User-selectable locales.
 *
 * Distinct from `AVAILABLE_LOCALES` (the catalog keys) on purpose:
 *
 *   AVAILABLE_LOCALES   catalog folders — 'en', 'fr-CA', 'zh-CN'
 *   SELECTABLE_LOCALES  what a tenant may STORE in AbTenantConfig.locale,
 *                       which is 'en-US' for English, not 'en'
 *
 * Every existing AbTenantConfig row stores `'en-US'` (the column default), so
 * the stored value and the catalog key are not the same string. `resolveLocale`
 * bridges them by falling back from a regional tag to its base language.
 *
 * WHY THIS LIST EXISTS
 * `AbTenantConfig.locale` had NO validation — the PATCH handler did
 * `if (body.locale) update.locale = body.locale`, accepting any string, while
 * its neighbours `businessType` and `taxEntityType` were whitelisted. One list,
 * exported here, keeps the API validator and the settings dropdown from
 * drifting apart.
 *
 * The whitelist MUST accept 'en-US'. A narrower list would reject every row
 * already in the database — the same failure mode that previously shipped as a
 * hotfix on `businessType`.
 */

export interface SelectableLocale {
  /** Value stored in AbTenantConfig.locale. */
  value: string;
  /** Native-language label, for the settings dropdown. */
  label: string;
  /** English label, for admin screens and logs. */
  englishLabel: string;
}

export const SELECTABLE_LOCALES: readonly SelectableLocale[] = Object.freeze([
  { value: 'en-US', label: 'English (US)', englishLabel: 'English (US)' },
  { value: 'fr-CA', label: 'Français (Canada)', englishLabel: 'French (Canada)' },
  { value: 'zh-CN', label: '简体中文', englishLabel: 'Chinese (Simplified)' },
]);

/** Just the storable values. */
export const SELECTABLE_LOCALE_VALUES: readonly string[] = Object.freeze(
  SELECTABLE_LOCALES.map((l) => l.value),
);

/**
 * Legacy values that already exist in the database and must keep validating
 * even though they are not offered in the picker. Rejecting a stored value
 * would break the settings page for that tenant.
 */
const LEGACY_ACCEPTED = Object.freeze(['en', 'en-CA', 'en-AU', 'en-GB', 'fr']);

/**
 * Is this an acceptable value for AbTenantConfig.locale?
 * Accepts the selectable set plus known legacy values, case-insensitively.
 */
export function isSelectableLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const v = value.trim().toLowerCase();
  return (
    SELECTABLE_LOCALE_VALUES.some((s) => s.toLowerCase() === v) ||
    LEGACY_ACCEPTED.some((s) => s.toLowerCase() === v)
  );
}

/** Canonical stored form for an accepted value ('ZH-cn' -> 'zh-CN'). */
export function canonicalizeLocale(value: string): string {
  const v = value.trim().toLowerCase();
  const hit =
    SELECTABLE_LOCALE_VALUES.find((s) => s.toLowerCase() === v) ??
    LEGACY_ACCEPTED.find((s) => s.toLowerCase() === v);
  return hit ?? value.trim();
}

/** Error message for a rejected value, matching the route's existing style. */
export function localeValidationError(): string {
  return `locale must be one of: ${SELECTABLE_LOCALE_VALUES.join(', ')}`;
}

/**
 * Locales that may actually be OFFERED to a user right now.
 *
 * A locale whose catalog is still `scaffold` has correct structure but English
 * placeholder values. Offering it would let someone pick "简体中文" and get an
 * English UI — worse than not offering it at all. Filtering the picker by
 * readiness means it grows on its own the moment a locale's content lands, with
 * no second list to remember to update.
 *
 * `isSelectableLocale` stays deliberately WIDER than this: a value already
 * stored in the database must keep validating even if it is not currently
 * offered, or that tenant cannot save their settings page.
 */
export function getOfferableLocales(
  localeStatus: Record<string, string>,
  resolveToCatalog: (tenantLocale: string) => string,
): readonly SelectableLocale[] {
  return SELECTABLE_LOCALES.filter((l) => {
    const status = localeStatus[resolveToCatalog(l.value)];
    return status === 'ready' || status === 'reference';
  });
}
