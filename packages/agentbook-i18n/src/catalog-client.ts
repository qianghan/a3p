/**
 * @agentbook/i18n/catalog-client — the packs a BROWSER can actually render.
 *
 * The same locale packs as '@agentbook/i18n/catalog', minus the namespaces
 * that only the server reaches. This is the entry point every client
 * component must use.
 *
 * WHY A SECOND ENTRY POINT RATHER THAN TREE-SHAKING
 *
 * Nothing tree-shakes the catalog, and nothing can. A default-imported JSON
 * module is one opaque value, so a bundler cannot lift individual namespaces
 * out of the object literal they are stored into; and `CATALOG[locale]` plus
 * readKey()'s dotted lookup are dynamic property access, so it cannot prove
 * any key unreachable either. Measured directly: a bundle importing
 * createTranslator and CATALOG to resolve ONE key is 96.7 kB gzipped, against
 * 728 bytes for the same bundle with an inline catalog. `en/bot.json` — 25 kB
 * of Telegram copy — is present in full for the sake of `nav.expenses`.
 *
 * In the real build that lands in one chunk which the root layout pulls into
 * every page route: the largest single chunk in First Load JS, larger than
 * React. Dropping the four server-only namespaces takes 36 kB off all 35 page
 * routes that carry it.
 *
 * WHY NOT A PER-ROUTE SPLIT
 *
 * Because there is no route-level import to make selective, and the answer is
 * not statically knowable anyway. See the long note in
 * apps/web-next/src/__tests__/architecture/i18n-client-catalog.test.ts.
 *
 * IMPORTS ARE STATIC, for the same reasons catalog.ts gives: bundlers can
 * inline them, there is no runtime fs and no fetch, and it behaves the same in
 * serverless — where dynamic asset loading is a reliable source of "works
 * locally, 500s in prod".
 *
 * ADDING A KEY  nothing to do here; a key in an existing namespace is picked
 * up automatically. ADDING A NAMESPACE  add it to CLIENT_NAMESPACES (or to
 * SERVER_ONLY_NAMESPACES) in locale-meta.ts and add the imports below.
 */

import type { Catalog } from './core.js';
import { LOCALE_TAGS } from './locale-meta.js';


// English — the reference locale.
import enAccounting from './locales/en/accounting.json';
import enAdminUi from './locales/en/admin_ui.json';
import enAgent from './locales/en/agent.json';
import enAgents from './locales/en/agents.json';
import enBilling from './locales/en/billing.json';
import enBillingUi from './locales/en/billing_ui.json';
import enCalendar from './locales/en/calendar.json';
import enChat from './locales/en/chat.json';
import enCommon from './locales/en/common.json';
import enCommunityUi from './locales/en/community_ui.json';
import enCoreUi from './locales/en/core_ui.json';
import enDash from './locales/en/dash.json';
import enDashboard from './locales/en/dashboard.json';
import enExpense from './locales/en/expense.json';
import enExpensesUi from './locales/en/expenses_ui.json';
import enHomeoffice from './locales/en/homeoffice.json';
import enInvoice from './locales/en/invoice.json';
import enInvoiceUi from './locales/en/invoice_ui.json';
import enNav from './locales/en/nav.json';
import enOnboarding from './locales/en/onboarding.json';
import enStartupUi from './locales/en/startup_ui.json';
import enStudentUi from './locales/en/student_ui.json';
import enTabs from './locales/en/tabs.json';
import enTax from './locales/en/tax.json';
import enTaxUi from './locales/en/tax_ui.json';

// Canadian French. CRA / Revenu Quebec terminology (TPS/TVQ, not TVA).
import frAccounting from './locales/fr-CA/accounting.json';
import frAdminUi from './locales/fr-CA/admin_ui.json';
import frAgent from './locales/fr-CA/agent.json';
import frAgents from './locales/fr-CA/agents.json';
import frBilling from './locales/fr-CA/billing.json';
import frBillingUi from './locales/fr-CA/billing_ui.json';
import frCalendar from './locales/fr-CA/calendar.json';
import frChat from './locales/fr-CA/chat.json';
import frCommon from './locales/fr-CA/common.json';
import frCommunityUi from './locales/fr-CA/community_ui.json';
import frCoreUi from './locales/fr-CA/core_ui.json';
import frDash from './locales/fr-CA/dash.json';
import frDashboard from './locales/fr-CA/dashboard.json';
import frExpense from './locales/fr-CA/expense.json';
import frExpensesUi from './locales/fr-CA/expenses_ui.json';
import frHomeoffice from './locales/fr-CA/homeoffice.json';
import frInvoice from './locales/fr-CA/invoice.json';
import frInvoiceUi from './locales/fr-CA/invoice_ui.json';
import frNav from './locales/fr-CA/nav.json';
import frOnboarding from './locales/fr-CA/onboarding.json';
import frStartupUi from './locales/fr-CA/startup_ui.json';
import frStudentUi from './locales/fr-CA/student_ui.json';
import frTabs from './locales/fr-CA/tabs.json';
import frTax from './locales/fr-CA/tax.json';
import frTaxUi from './locales/fr-CA/tax_ui.json';

// Simplified Chinese.
import zhAccounting from './locales/zh-CN/accounting.json';
import zhAdminUi from './locales/zh-CN/admin_ui.json';
import zhAgent from './locales/zh-CN/agent.json';
import zhAgents from './locales/zh-CN/agents.json';
import zhBilling from './locales/zh-CN/billing.json';
import zhBillingUi from './locales/zh-CN/billing_ui.json';
import zhCalendar from './locales/zh-CN/calendar.json';
import zhChat from './locales/zh-CN/chat.json';
import zhCommon from './locales/zh-CN/common.json';
import zhCommunityUi from './locales/zh-CN/community_ui.json';
import zhCoreUi from './locales/zh-CN/core_ui.json';
import zhDash from './locales/zh-CN/dash.json';
import zhDashboard from './locales/zh-CN/dashboard.json';
import zhExpense from './locales/zh-CN/expense.json';
import zhExpensesUi from './locales/zh-CN/expenses_ui.json';
import zhHomeoffice from './locales/zh-CN/homeoffice.json';
import zhInvoice from './locales/zh-CN/invoice.json';
import zhInvoiceUi from './locales/zh-CN/invoice_ui.json';
import zhNav from './locales/zh-CN/nav.json';
import zhOnboarding from './locales/zh-CN/onboarding.json';
import zhStartupUi from './locales/zh-CN/startup_ui.json';
import zhStudentUi from './locales/zh-CN/student_ui.json';
import zhTabs from './locales/zh-CN/tabs.json';
import zhTax from './locales/zh-CN/tax.json';
import zhTaxUi from './locales/zh-CN/tax_ui.json';

/**
 * The client-side catalog. Shape is identical to CATALOG — `{ locale: { namespace: … } }`
 * — so core.ts needs no knowledge that a subset exists.
 */
export const CLIENT_CATALOG: Catalog = Object.freeze({
  'en': {
    accounting: enAccounting,
    admin_ui: enAdminUi,
    agent: enAgent,
    agents: enAgents,
    billing: enBilling,
    billing_ui: enBillingUi,
    calendar: enCalendar,
    chat: enChat,
    common: enCommon,
    community_ui: enCommunityUi,
    core_ui: enCoreUi,
    dash: enDash,
    dashboard: enDashboard,
    expense: enExpense,
    expenses_ui: enExpensesUi,
    homeoffice: enHomeoffice,
    invoice: enInvoice,
    invoice_ui: enInvoiceUi,
    nav: enNav,
    onboarding: enOnboarding,
    startup_ui: enStartupUi,
    student_ui: enStudentUi,
    tabs: enTabs,
    tax: enTax,
    tax_ui: enTaxUi,
  },
  'fr-CA': {
    accounting: frAccounting,
    admin_ui: frAdminUi,
    agent: frAgent,
    agents: frAgents,
    billing: frBilling,
    billing_ui: frBillingUi,
    calendar: frCalendar,
    chat: frChat,
    common: frCommon,
    community_ui: frCommunityUi,
    core_ui: frCoreUi,
    dash: frDash,
    dashboard: frDashboard,
    expense: frExpense,
    expenses_ui: frExpensesUi,
    homeoffice: frHomeoffice,
    invoice: frInvoice,
    invoice_ui: frInvoiceUi,
    nav: frNav,
    onboarding: frOnboarding,
    startup_ui: frStartupUi,
    student_ui: frStudentUi,
    tabs: frTabs,
    tax: frTax,
    tax_ui: frTaxUi,
  },
  'zh-CN': {
    accounting: zhAccounting,
    admin_ui: zhAdminUi,
    agent: zhAgent,
    agents: zhAgents,
    billing: zhBilling,
    billing_ui: zhBillingUi,
    calendar: zhCalendar,
    chat: zhChat,
    common: zhCommon,
    community_ui: zhCommunityUi,
    core_ui: zhCoreUi,
    dash: zhDash,
    dashboard: zhDashboard,
    expense: zhExpense,
    expenses_ui: zhExpensesUi,
    homeoffice: zhHomeoffice,
    invoice: zhInvoice,
    invoice_ui: zhInvoiceUi,
    nav: zhNav,
    onboarding: zhOnboarding,
    startup_ui: zhStartupUi,
    student_ui: zhStudentUi,
    tabs: zhTabs,
    tax: zhTax,
    tax_ui: zhTaxUi,
  },
});

/**
 * Locale metadata, re-exported so a client component needs exactly one import
 * and cannot reach for the catalog-derived versions by accident.
 */
export { CLIENT_NAMESPACES, SERVER_ONLY_NAMESPACES, LOCALE_STATUS } from './locale-meta.js';
export type { LocaleReadiness } from './locale-meta.js';

/** Locales this build can serve. Asserted to equal Object.keys(CATALOG). */
export const AVAILABLE_LOCALES: string[] = LOCALE_TAGS;

/**
 * Locales offerable to a user right now. The implementation is in
 * locale-meta.ts, which holds no translation data — this is the import path a
 * client component must use, because the one behind '@agentbook/i18n/catalog'
 * reaches it through CATALOG and carries every string in the product with it.
 */
export { offerableLocales } from './locale-meta.js';
