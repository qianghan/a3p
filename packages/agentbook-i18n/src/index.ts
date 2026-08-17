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

import { resolveLocale as _resolveLocale } from './core.js';
import { LOCALE_STATUS as _LOCALE_STATUS, AVAILABLE_LOCALES as _AVAILABLE } from './catalog.js';
import { getOfferableLocales as _getOfferable } from './selectable.js';

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

export {
  getOfferableLocales,
  SELECTABLE_LOCALES,
  SELECTABLE_LOCALE_VALUES,
  isSelectableLocale,
  canonicalizeLocale,
  localeValidationError,
} from './selectable.js';
export type { SelectableLocale } from './selectable.js';

/**
 * Locales offerable to a user right now — the selectable set filtered by
 * catalog readiness, so a `scaffold` locale is never presented as a choice.
 * Pre-bound to this build's CATALOG and LOCALE_STATUS.
 */
export function offerableLocales() {
  return _getOfferable(_LOCALE_STATUS, (tenantLocale) =>
    _resolveLocale({ tenantLocale }, _AVAILABLE),
  );
}

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

/**
 * Locale-aware INPUT parsing. Paired with the formatters above deliberately:
 * localising output without localising input reads a fr-CA user's "45,50" as
 * 4550 and books $4,550.00 — a silent 100x error straight into the ledger.
 *
 * `parseAmountToCents` reports `ambiguous` rather than guessing when a value
 * like "1,500" could mean two things 1000x apart. Callers must echo `formatted`
 * back for confirmation before writing an ambiguous amount.
 */
export { parseAmountToCents, parseDateInput } from './parse.js';
export type { ParsedAmount, ParsedDate } from './parse.js';
