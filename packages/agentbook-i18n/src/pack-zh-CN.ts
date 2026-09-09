/**
 * The zh-CN pack, as ONE lazily-loaded module.
 *
 * Simplified Chinese.
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

const pack: Record<string, TranslationData> = Object.freeze({
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
});

export default pack;
