/**
 * The fr-CA pack, as ONE lazily-loaded module.
 *
 * Canadian French. CRA / Revenu Quebec terminology (TPS/TVQ, not TVA).
 *
 * WHY A PACK MODULE RATHER THAN 25 SEPARATE import() CALLS
 *
 * Webpack emits a chunk per dynamic import. Importing each namespace on its
 * own would mean 25 requests to change language; this file is imported once,
 * so the whole locale arrives as a single chunk.
 *
 * Every path below is a LITERAL. A computed one — import(`./locales/${tag}/...`)
 * — makes webpack build a context module containing every locale, which is
 * both the opposite of the point and exactly the "works locally, 500s in prod"
 * hazard catalog.ts's header warns about.
 *
 * Generated shape, kept in step with CLIENT_NAMESPACES by
 * apps/web-next/src/__tests__/architecture/i18n-client-catalog.test.ts, which
 * loads this pack and compares it against the full catalog key by key.
 */

import type { TranslationData } from './core.js';

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

const pack: Record<string, TranslationData> = Object.freeze({
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
});

export default pack;
