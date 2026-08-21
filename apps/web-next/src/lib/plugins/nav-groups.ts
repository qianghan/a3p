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

/**
 * Translation keys for the same headings, for the sidebar to resolve at render.
 *
 * A parallel map rather than replacing NAV_GROUP_LABEL: that constant is the
 * English source of truth and is read by non-React code that has no translator.
 * The catalog invariants assert key parity across locales, so a heading added
 * here without a translation fails CI rather than rendering a raw key.
 */
export const NAV_GROUP_LABEL_KEY: Record<NavGroupId, string> = {
  accounting: 'nav.group_accounting',
  personal: 'nav.group_personal',
  'for-your-business': 'nav.group_for_your_business',
  'advisors-community': 'nav.group_advisors_community',
  resources: 'nav.group_resources',
};

/**
 * A plugin's sidebar label.
 *
 * `displayName` is a row in the DB plugin registry, so it cannot be translated
 * at the call site. We look for `nav.plugin_<normalizedName>` and fall back to
 * displayName when there is no key — a third-party plugin installed tomorrow
 * shows its own name rather than a raw dotted key.
 */
export function pluginLabel(
  t: (key: string) => string,
  normalizedName: string,
  displayName: string,
): string {
  const key = `nav.plugin_${normalizedName}`;
  const translated = t(key);
  // t() returns the key itself on a miss, which is the signal for "no
  // translation exists for this plugin".
  return translated === key ? displayName : translated;
}

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
