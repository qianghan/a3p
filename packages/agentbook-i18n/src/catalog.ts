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
import enBilling from './locales/en/billing.json';
import enStartupUi from './locales/en/startup_ui.json';
import enBillingUi from './locales/en/billing_ui.json';
import enAccounting from './locales/en/accounting.json';
import enAgents from './locales/en/agents.json';
import enCalendar from './locales/en/calendar.json';
import enChat from './locales/en/chat.json';
import enCommon from './locales/en/common.json';
import enCoreUi from './locales/en/core_ui.json';
import enDashboard from './locales/en/dashboard.json';
import enExpense from './locales/en/expense.json';
import enExpensesUi from './locales/en/expenses_ui.json';
import enHomeOffice from './locales/en/homeoffice.json';
import enInvoice from './locales/en/invoice.json';
import enInvoiceUi from './locales/en/invoice_ui.json';
import enOnboarding from './locales/en/onboarding.json';
import enNav from './locales/en/nav.json';
import enDash from './locales/en/dash.json';
import enTabs from './locales/en/tabs.json';
import enStudentUi from './locales/en/student_ui.json';
import enCommunityUi from './locales/en/community_ui.json';
import enProactive from './locales/en/proactive.json';
import enRate from './locales/en/rate.json';
import enTax from './locales/en/tax.json';
import enTaxUi from './locales/en/tax_ui.json';

// Canadian French. Tax and accounting nouns follow CRA / Revenu Québec
// official terminology (TPS/TVQ, not TVA) — see plan decision D4.
import frAgent from './locales/fr-CA/agent.json';
import frBilling from './locales/fr-CA/billing.json';
import frStartupUi from './locales/fr-CA/startup_ui.json';
import frBillingUi from './locales/fr-CA/billing_ui.json';
import frAccounting from './locales/fr-CA/accounting.json';
import frAgents from './locales/fr-CA/agents.json';
import frCalendar from './locales/fr-CA/calendar.json';
import frChat from './locales/fr-CA/chat.json';
import frCommon from './locales/fr-CA/common.json';
import frCoreUi from './locales/fr-CA/core_ui.json';
import frDashboard from './locales/fr-CA/dashboard.json';
import frExpense from './locales/fr-CA/expense.json';
import frExpensesUi from './locales/fr-CA/expenses_ui.json';
import frHomeOffice from './locales/fr-CA/homeoffice.json';
import frInvoice from './locales/fr-CA/invoice.json';
import frInvoiceUi from './locales/fr-CA/invoice_ui.json';
import frOnboarding from './locales/fr-CA/onboarding.json';
import frNav from './locales/fr-CA/nav.json';
import frDash from './locales/fr-CA/dash.json';
import frTabs from './locales/fr-CA/tabs.json';
import frStudentUi from './locales/fr-CA/student_ui.json';
import frCommunityUi from './locales/fr-CA/community_ui.json';
import frProactive from './locales/fr-CA/proactive.json';
import frRate from './locales/fr-CA/rate.json';
import frTax from './locales/fr-CA/tax.json';
import frTaxUi from './locales/fr-CA/tax_ui.json';

// Simplified Chinese.
import zhAgent from './locales/zh-CN/agent.json';
import zhBilling from './locales/zh-CN/billing.json';
import zhStartupUi from './locales/zh-CN/startup_ui.json';
import zhBillingUi from './locales/zh-CN/billing_ui.json';
import zhAccounting from './locales/zh-CN/accounting.json';
import zhAgents from './locales/zh-CN/agents.json';
import zhCalendar from './locales/zh-CN/calendar.json';
import zhChat from './locales/zh-CN/chat.json';
import zhCommon from './locales/zh-CN/common.json';
import zhCoreUi from './locales/zh-CN/core_ui.json';
import zhDashboard from './locales/zh-CN/dashboard.json';
import zhExpense from './locales/zh-CN/expense.json';
import zhExpensesUi from './locales/zh-CN/expenses_ui.json';
import zhHomeOffice from './locales/zh-CN/homeoffice.json';
import zhInvoice from './locales/zh-CN/invoice.json';
import zhInvoiceUi from './locales/zh-CN/invoice_ui.json';
import zhOnboarding from './locales/zh-CN/onboarding.json';
import zhNav from './locales/zh-CN/nav.json';
import zhDash from './locales/zh-CN/dash.json';
import zhTabs from './locales/zh-CN/tabs.json';
import zhStudentUi from './locales/zh-CN/student_ui.json';
import zhCommunityUi from './locales/zh-CN/community_ui.json';
import zhProactive from './locales/zh-CN/proactive.json';
import zhRate from './locales/zh-CN/rate.json';
import zhTax from './locales/zh-CN/tax.json';
import zhTaxUi from './locales/zh-CN/tax_ui.json';

/**
 * Namespace keys become the first segment of a translation key:
 * `expense.json` → `t('expense.receipt_saved')`.
 */
export const CATALOG: Catalog = Object.freeze({
  en: {
    agent: enAgent,
    billing: enBilling,
    startup_ui: enStartupUi,
    billing_ui: enBillingUi,
    accounting: enAccounting,
    agents: enAgents,
    calendar: enCalendar,
    chat: enChat,
    common: enCommon,
    core_ui: enCoreUi,
    dashboard: enDashboard,
    expense: enExpense,
    expenses_ui: enExpensesUi,
    homeoffice: enHomeOffice,
    invoice: enInvoice,
    invoice_ui: enInvoiceUi,
    onboarding: enOnboarding,
    nav: enNav,
    dash: enDash,
    tabs: enTabs,
    student_ui: enStudentUi,
    community_ui: enCommunityUi,
    proactive: enProactive,
    rate: enRate,
    tax: enTax,
    tax_ui: enTaxUi,
  },
  'fr-CA': {
    agent: frAgent,
    billing: frBilling,
    startup_ui: frStartupUi,
    billing_ui: frBillingUi,
    accounting: frAccounting,
    agents: frAgents,
    calendar: frCalendar,
    chat: frChat,
    common: frCommon,
    core_ui: frCoreUi,
    dashboard: frDashboard,
    expense: frExpense,
    expenses_ui: frExpensesUi,
    homeoffice: frHomeOffice,
    invoice: frInvoice,
    invoice_ui: frInvoiceUi,
    onboarding: frOnboarding,
    nav: frNav,
    dash: frDash,
    tabs: frTabs,
    student_ui: frStudentUi,
    community_ui: frCommunityUi,
    proactive: frProactive,
    rate: frRate,
    tax: frTax,
    tax_ui: frTaxUi,
  },
  'zh-CN': {
    agent: zhAgent,
    billing: zhBilling,
    startup_ui: zhStartupUi,
    billing_ui: zhBillingUi,
    accounting: zhAccounting,
    agents: zhAgents,
    calendar: zhCalendar,
    chat: zhChat,
    common: zhCommon,
    core_ui: zhCoreUi,
    dashboard: zhDashboard,
    expense: zhExpense,
    expenses_ui: zhExpensesUi,
    homeoffice: zhHomeOffice,
    invoice: zhInvoice,
    invoice_ui: zhInvoiceUi,
    onboarding: zhOnboarding,
    nav: zhNav,
    dash: zhDash,
    tabs: zhTabs,
    student_ui: zhStudentUi,
    community_ui: zhCommunityUi,
    proactive: zhProactive,
    rate: zhRate,
    tax: zhTax,
    tax_ui: zhTaxUi,
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
  'zh-CN': 'ready',
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
