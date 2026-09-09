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
 *
 * AND SHELL CLIENT CODE SHOULD NOT USE THIS EITHER
 *
 * This is the FULL catalog, including the four namespaces only the server
 * reaches. ShellProvider is rendered by the root layout, so whatever it
 * imports is in every page route's First Load JS — 36 kB gzipped of Telegram
 * and agent-skill copy that no browser can render. Client code wants
 * '@agentbook/i18n/catalog-client'. `bin/i18n-bundle-guard.sh --shell`
 * asserts the difference against the built chunks.
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

/**
 * Locales offerable to a user right now — the selectable set filtered by
 * catalog readiness, so a `scaffold` locale is never presented as a choice.
 *
 * Re-exported from locale-meta.ts rather than built here. It used to be built
 * here from AVAILABLE_LOCALES, i.e. Object.keys(CATALOG), which meant a client
 * component importing nothing but this function pulled in all three locale
 * packs — 97 kB gzipped for a list of three language names. Client code should
 * import it from '@agentbook/i18n/catalog-client'; this export stays so
 * server-side callers need not change.
 */
export { offerableLocales } from './locale-meta.js';
