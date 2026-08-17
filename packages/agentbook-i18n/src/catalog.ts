/**
 * The static translation catalog.
 *
 * Replaces the old loader.ts, which mutated module-global state via
 * loadLocale() at import time. This module exports frozen data instead: there
 * is nothing to initialise, nothing to call in the wrong order, and nothing
 * that can differ between two concurrent requests.
 *
 * Imports are static rather than dynamic so that:
 *   - bundlers can tree-shake and inline them (no runtime fs, no fetch)
 *   - it works unchanged in serverless, where dynamic asset loading is a
 *     common source of "works locally, 500s in prod"
 *
 * ADDING A LOCALE
 *   1. create src/locales/<tag>/ with one JSON file per namespace
 *   2. add the imports and one CATALOG entry below
 *   3. the architecture invariants (apps/web-next/src/__tests__/architecture/)
 *      will fail until the new locale has full key parity with `en`
 *
 * ADDING A KEY
 *   Add it to en/<namespace>.json first — `en` is the reference set that
 *   parity is measured against — then to every other locale.
 */

import type { Catalog } from './core.js';

// English — the reference locale. Every key must exist here.
import enAgent from './locales/en/agent.json';
import enCalendar from './locales/en/calendar.json';
import enCommon from './locales/en/common.json';
import enExpense from './locales/en/expense.json';
import enInvoice from './locales/en/invoice.json';
import enProactive from './locales/en/proactive.json';
import enRate from './locales/en/rate.json';
import enTax from './locales/en/tax.json';

// Canadian French. Tax and accounting nouns follow CRA / Revenu Québec
// official terminology (TPS/TVQ, not TVA) — see plan decision D4.
import frAgent from './locales/fr-CA/agent.json';
import frCalendar from './locales/fr-CA/calendar.json';
import frCommon from './locales/fr-CA/common.json';
import frExpense from './locales/fr-CA/expense.json';
import frInvoice from './locales/fr-CA/invoice.json';
import frProactive from './locales/fr-CA/proactive.json';
import frRate from './locales/fr-CA/rate.json';
import frTax from './locales/fr-CA/tax.json';

// Simplified Chinese.
import zhAgent from './locales/zh-CN/agent.json';
import zhCalendar from './locales/zh-CN/calendar.json';
import zhCommon from './locales/zh-CN/common.json';
import zhExpense from './locales/zh-CN/expense.json';
import zhInvoice from './locales/zh-CN/invoice.json';
import zhProactive from './locales/zh-CN/proactive.json';
import zhRate from './locales/zh-CN/rate.json';
import zhTax from './locales/zh-CN/tax.json';

/**
 * Namespace keys become the first segment of a translation key:
 * `expense.json` → `t('expense.receipt_saved')`.
 */
export const CATALOG: Catalog = Object.freeze({
  en: {
    agent: enAgent,
    calendar: enCalendar,
    common: enCommon,
    expense: enExpense,
    invoice: enInvoice,
    proactive: enProactive,
    rate: enRate,
    tax: enTax,
  },
  'fr-CA': {
    agent: frAgent,
    calendar: frCalendar,
    common: frCommon,
    expense: frExpense,
    invoice: frInvoice,
    proactive: frProactive,
    rate: frRate,
    tax: frTax,
  },
  'zh-CN': {
    agent: zhAgent,
    calendar: zhCalendar,
    common: zhCommon,
    expense: zhExpense,
    invoice: zhInvoice,
    proactive: zhProactive,
    rate: zhRate,
    tax: zhTax,
  },
});

/**
 * Locales this build can serve. Derived from CATALOG rather than declared
 * separately, so the two can never drift apart.
 */
export const AVAILABLE_LOCALES: string[] = Object.keys(CATALOG);

/**
 * Translation readiness, per locale.
 *
 *   reference  the source of truth for keys ('en')
 *   ready      fully translated; content invariants apply
 *   scaffold   correct STRUCTURE, but values are still English placeholders
 *
 * Why this exists: a locale is built in two steps — structure first (so every
 * call site can be wired and type-checked), content second. Without an
 * explicit marker, the content invariants would either have to be omitted
 * (and then never added) or would block the structural work that has to land
 * first. Naming the state keeps both honest.
 *
 * A `scaffold` locale MUST NOT be user-selectable. The i18n feature flag is
 * what enforces that, and flipping it on while any locale is still `scaffold`
 * is a release error — asserted in the architecture suite.
 */
export type LocaleReadiness = 'reference' | 'ready' | 'scaffold';

export const LOCALE_STATUS: Record<string, LocaleReadiness> = Object.freeze({
  en: 'reference',
  'fr-CA': 'ready',
  // Structure landed with the foundation; content is a follow-up PR.
  'zh-CN': 'scaffold',
});

/** Locales whose content is finished and therefore content-invariant-checked. */
export const TRANSLATED_LOCALES: string[] = AVAILABLE_LOCALES.filter(
  (l) => LOCALE_STATUS[l] === 'ready',
);

/** Locales still awaiting translated values. Must be empty before GA. */
export const SCAFFOLD_LOCALES: string[] = AVAILABLE_LOCALES.filter(
  (l) => LOCALE_STATUS[l] === 'scaffold',
);

/**
 * The reference locale. Keys are defined here first and parity for every
 * other locale is measured against it.
 */
export const REFERENCE_LOCALE = 'en';

/** Namespaces present in the reference locale. */
export const NAMESPACES: string[] = Object.keys(CATALOG[REFERENCE_LOCALE]).sort();
