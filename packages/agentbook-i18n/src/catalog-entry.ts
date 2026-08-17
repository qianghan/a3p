/**
 * @agentbook/i18n/catalog — the translation packs.
 *
 * SHELL ONLY. Importing this from a plugin frontend inlines all three locale
 * packs into that plugin's UMD bundle (+18.8 KB measured), duplicating them
 * across six CDN bundles and defeating the shared-translator architecture.
 * Plugins receive a ready-built translator through ShellContext instead — see
 * the SDK's useI18n().
 *
 * A bundle-size guard asserts these strings never appear in a plugin bundle.
 */

export {
  CATALOG,
  AVAILABLE_LOCALES,
  REFERENCE_LOCALE,
  NAMESPACES,
  LOCALE_STATUS,
  TRANSLATED_LOCALES,
  SCAFFOLD_LOCALES,
} from './catalog.js';
export type { LocaleReadiness } from './catalog.js';

import { resolveLocale } from './core.js';
import { LOCALE_STATUS, AVAILABLE_LOCALES } from './catalog.js';
import { getOfferableLocales } from './selectable.js';

/**
 * Locales offerable to a user right now — the selectable set filtered by
 * catalog readiness, so a `scaffold` locale is never presented as a choice.
 * Pre-bound to this build's CATALOG and LOCALE_STATUS.
 */
export function offerableLocales() {
  return getOfferableLocales(LOCALE_STATUS, (tenantLocale) =>
    resolveLocale({ tenantLocale }, AVAILABLE_LOCALES),
  );
}
