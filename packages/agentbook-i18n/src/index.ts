/**
 * @agentbook/i18n — FUNCTION surface. Deliberately catalog-free.
 *
 * WHY THE CATALOG IS NOT EXPORTED HERE
 *
 * All six plugin frontends import `formatMoney` from this package (21 call
 * sites). When the translation CATALOG lived in this same barrel, every plugin
 * bundle inlined all three locale packs — measured at +18.8 KB per bundle,
 * roughly 113 KB of duplicated strings across six CDN bundles, and it defeated
 * the whole point of injecting one shared translator through ShellContext.
 *
 * So the split is load-bearing, not cosmetic:
 *
 *   @agentbook/i18n           functions only — safe for plugin bundles
 *   @agentbook/i18n/catalog   the locale packs — imported by the SHELL only
 *
 * A bundle-size guard asserts the packs stay out of plugin bundles, because
 * this regressed once already and the failure is invisible without measuring.
 *
 * Usage (per request / per render — never a module-level singleton):
 *
 *   import { createTranslator, resolveLocale } from '@agentbook/i18n';
 *   import { CATALOG, AVAILABLE_LOCALES } from '@agentbook/i18n/catalog';
 *
 *   const locale = resolveLocale({ tenantLocale: cfg.locale }, AVAILABLE_LOCALES);
 *   const { t } = createTranslator(locale, CATALOG);
 *
 * There is deliberately no setLocale()/getLocale(). See core.ts for why.
 */

export { createTranslator, resolveLocale, DEFAULT_LOCALE } from './core.js';
export type { Translator, Catalog, TranslationData } from './core.js';

/**
 * Formatters. Unchanged by the translator rewrite — they already take `locale`
 * explicitly and were never part of the ambient-state problem.
 *
 * `formatMoney` has 21 call sites across all six plugin frontends and the
 * Telegram webhook, so its name and signature are a hard compatibility surface.
 * Dropping it from this list breaks every money figure in the product, which is
 * exactly what happened once during this work and was caught only because the
 * plugin test suites had just been un-masked.
 *
 * Note: formatMoney infers its display locale from the CURRENCY code, not from
 * the user's locale, so a fr-CA user with a CAD account gets en-CA formatting.
 */
export {
  formatCurrency,
  formatMoney,
  formatDate,
  formatDateOnly,
  formatNumber,
  formatPercent,
} from './formatters.js';

/**
 * Locale-aware INPUT parsing. Paired with the formatters deliberately:
 * localising output without localising input reads a fr-CA user's "45,50" as
 * 4550 and books $4,550.00 — a silent 100x error into the ledger. Form inputs
 * fail differently but just as badly: parseFloat('45,50') is 45, and
 * parseFloat('1 500,75') is 1.
 *
 * `parseAmountToCents` reports `ambiguous` rather than guessing when a value
 * like "1,500" could mean two things 1000x apart. Callers must echo `formatted`
 * back for confirmation before writing an ambiguous amount.
 */
export { parseAmountToCents, parseDateInput } from './parse.js';
export type { ParsedAmount, ParsedDate } from './parse.js';

/**
 * Selectable-locale data and validation. Pure data + predicates, no catalog.
 * `getOfferableLocales` is here but needs readiness passed in; the shell should
 * prefer `offerableLocales()` from '@agentbook/i18n/catalog', which binds it.
 */
export {
  getOfferableLocales,
  SELECTABLE_LOCALES,
  SELECTABLE_LOCALE_VALUES,
  isSelectableLocale,
  canonicalizeLocale,
  localeValidationError,
} from './selectable.js';
export type { SelectableLocale } from './selectable.js';
