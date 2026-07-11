/**
 * Plugin → sidebar nav group.
 *
 * The sidebar used to render every plugin in one flat "Main" list ordered
 * only by a numeric `order` field — Expenses, Startup Tax Benefits,
 * Scholarships, Payroll, Personal finance, etc. all sat at the same level
 * with no grouping by purpose. This map assigns each plugin to a coherent
 * section instead.
 *
 * Mirrors the shape of addon-gate.ts / business-type-gate.ts: DEFAULT-OPEN
 * (a plugin absent from this map falls back to 'accounting', since every
 * plugin added so far has been an accounting-adjacent tool — revisit this
 * default if a plugin outside that shape ever ships).
 *
 * agentbook-core is deliberately absent — the sidebar renders it separately
 * as the standalone "Dashboard" link, not grouped with anything.
 */

export type NavGroupId = 'accounting' | 'personal' | 'for-your-business' | 'advisors-community' | 'resources';

export const NAV_GROUP_LABEL: Record<NavGroupId, string> = {
  accounting: 'Accounting',
  personal: 'Personal',
  'for-your-business': 'For your business',
  'advisors-community': 'Advisors & Community',
  resources: 'Resources',
};

// Only the sections a plugin can realistically land in via the registry.
// Native (non-plugin) pages — Bills, Payroll, Personal finance, Account
// Access, Marketplace, Feedback, Teams, Docs — are assigned their section
// directly in sidebar.tsx, since they have no plugin.json to read from.
export const PLUGIN_NAV_GROUP: Record<string, Extract<NavGroupId, 'accounting' | 'for-your-business' | 'advisors-community'>> = {
  agentbookexpense: 'accounting',
  agentbookinvoice: 'accounting',
  agentbooktax: 'accounting',
  agentbookstartup: 'for-your-business',
  agentbookscholarship: 'for-your-business',
  agentbookcareer: 'for-your-business',
  agentbookhousing: 'for-your-business',
  community: 'advisors-community',
};

export function pluginNavGroup(normalizedName: string): NavGroupId {
  return PLUGIN_NAV_GROUP[normalizedName] ?? 'accounting';
}
