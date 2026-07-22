/**
 * Minimal, dependency-free i18n helper — French UI Phase 1 (Quebec).
 *
 * Deliberately NOT a full framework (no next-intl, no App Router
 * restructuring): Phase 1's string set is a handful of keys, not the whole
 * app. Revisit if a later phase needs full bilingual UI coverage.
 *
 * Reuses the pre-existing `AbTenantConfig.locale` column (a BCP-47 tag like
 * 'en-US' / 'fr-CA', already wired for Intl currency/date formatting — see
 * apps/web-next/src/lib/jurisdiction-currency.ts) rather than introducing a
 * second, conflicting locale field. This module only cares about the
 * language subtag, collapsed to the narrow `Locale` type below.
 */
import en from './messages/en.json';
import fr from './messages/fr.json';

export type Locale = 'en' | 'fr';

type MessageTable = Record<string, string>;

const MESSAGES: Record<Locale, MessageTable> = { en, fr };

/**
 * Resolve a translation key for the given locale. Falls back to English
 * when the key is missing for the requested locale, then to the key itself
 * if it's missing everywhere (never throws on an unknown key).
 */
export function t(key: string, locale: Locale = 'en'): string {
  const table = MESSAGES[locale] ?? MESSAGES.en;
  return table[key] ?? MESSAGES.en[key] ?? key;
}

/**
 * Collapse a raw BCP-47 locale string (or null/undefined) to the narrow
 * `Locale` type this module supports. Anything not starting with 'fr'
 * (including unset/unrecognized values) is treated as English — matching
 * the tenant-config default of 'en-US'.
 */
export function normalizeLocale(raw: string | null | undefined): Locale {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * Look up a tenant's simplified chat/UI locale from AbTenantConfig.
 * Separate from the DB-free `normalizeLocale` above so callers that already
 * have the tenant's config row (or want to unit-test the pure mapping logic)
 * don't need to touch the database.
 */
export async function getTenantLocale(tenantId: string): Promise<Locale> {
  const { prisma: db } = await import('@naap/database');
  const config = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { locale: true },
  });
  return normalizeLocale(config?.locale);
}
