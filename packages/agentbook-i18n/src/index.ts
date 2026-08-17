/**
 * @agentbook/i18n — public surface.
 *
 * Usage (per request / per render — never a module-level singleton):
 *
 *   import { createTranslator, resolveLocale, CATALOG, AVAILABLE_LOCALES } from '@agentbook/i18n';
 *
 *   const locale = resolveLocale(
 *     { tenantLocale: cfg.locale, acceptLanguage: req.headers.get('accept-language') },
 *     AVAILABLE_LOCALES,
 *   );
 *   const { t } = createTranslator(locale, CATALOG);
 *
 * There is deliberately no setLocale()/getLocale(). See core.ts for why.
 */

export { createTranslator, resolveLocale, DEFAULT_LOCALE } from './core.js';
export type { Translator, Catalog, TranslationData } from './core.js';

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
 * Formatters. Unchanged by the translator rewrite — they already take `locale`
 * explicitly and were never part of the ambient-state problem.
 *
 * `formatMoney` has 21 call sites across all six plugin frontends and the
 * Telegram webhook, so its name and signature are a hard compatibility
 * surface. Dropping it from this export list breaks every money figure in the
 * product, which is exactly what happened once during this rewrite and was
 * caught only because the plugin test suites had just been un-masked.
 *
 * Note for the money/date I/O work: formatMoney infers its display locale from
 * the CURRENCY code, not from the user's locale. A French-Canadian user with a
 * CAD account therefore gets en-CA formatting. Reconciling that is the
 * formatting PR's job, not this one's.
 */
export {
  formatCurrency,
  formatMoney,
  formatDate,
  formatNumber,
  formatPercent,
} from './formatters.js';
