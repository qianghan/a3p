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

import type { Catalog, TranslationData } from './core.js';
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


/**
 * The client-side catalog: the REFERENCE LOCALE ONLY, statically.
 *
 * Shape is identical to CATALOG — `{ locale: { namespace: … } }` — so core.ts
 * needs no knowledge that this is a subset.
 *
 * `en` is here rather than lazy because it is needed synchronously and
 * unconditionally. `translationEnabled` starts false, so the first paint is
 * English even for a tenant stored as fr-CA (fail-closed, decision D2), and
 * `en` is the last link in every lookup chain — so a key missing from a
 * lazily-loaded pack still resolves to real text instead of a dotted key.
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

/**
 * Load one non-reference locale's pack, on demand.
 *
 * WHY THE OTHER LOCALES ARE NOT STATIC
 *
 * A browser needs one language and was being sent three: another 43 kB gzipped
 * on every page route, measured, and dead weight for every user by definition.
 *
 * WHY A DYNAMIC IMPORT IS ALLOWED HERE
 *
 * catalog.ts's header forbids dynamic loading, and means something specific by
 * it: runtime `fs`, or `fetch` of an asset at a computed path — the reliable
 * road to "works locally, 500s in prod". This is neither. Every specifier
 * below is a literal, so webpack resolves it at BUILD time and emits a chunk
 * next to all the others; there is no filesystem and no URL anyone can get
 * wrong. It is also client-only — chunk loading is how the app already works
 * there — while the server keeps importing the full static CATALOG.
 *
 * WHY IT ADDS NO NEW LATENCY CLASS
 *
 * A non-`en` pack is only wanted once /tenant-config has resolved and the flag
 * is on, and that was already an await which already caused a re-render from
 * English to the tenant's language. This rides that boundary rather than
 * introducing one.
 *
 * FAILURE IS ENGLISH, NOT A BROKEN PAGE
 *
 * Returns null for a locale this build cannot serve, and callers are expected
 * to treat a rejection the same way. An AbTenantConfig row can hold a tag that
 * no longer ships, and a chunk request can simply fail; neither may take a page
 * down mid-render, so both degrade to the static `en` pack.
 */
export async function loadLocalePack(tag: string): Promise<Record<string, TranslationData> | null> {
  // A literal switch, not a lookup table of thunks: it is what makes each
  // specifier statically analysable, and it makes an unhandled locale a
  // visible gap rather than an undefined call.
  switch (tag) {
    case 'fr-CA':
      return (await import('./pack-fr-CA.js')).default;
    case 'zh-CN':
      return (await import('./pack-zh-CN.js')).default;
    default:
      return null;
  }
}