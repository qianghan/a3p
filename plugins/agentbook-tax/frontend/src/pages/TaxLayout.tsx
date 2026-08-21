import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useI18n } from '@naap/plugin-sdk';

/**
 * Shared tab bar for Tax: Dashboard and Tax Package. Before this, Tax
 * Package was only reachable via a link from the Dashboard, with no way
 * back. Kept deliberately minimal — Quarterly/Deductions/Cash Flow/
 * Analytics/What If/Reports stay reachable at their existing routes but are
 * not surfaced as top-level tabs; Dashboard + Tax Package is the full nav.
 *
 * Plain <a> links, not react-router <Link>: each tab is its own top-level
 * /agentbook/* route handled by the outer Next.js middleware rewrite, so
 * navigation is a full page load regardless. IMPORTANT: hrefs must be
 * /agentbook/<path> — NOT /agentbook/tax/<path> — because the plugin's own
 * router (see getInitialPath() in App.tsx) strips only the "/agentbook"
 * prefix and matches what's left against routes like "/" and "/tax-package".
 * An extra "/tax" segment doesn't match any route and silently falls back to
 * the catch-all (Dashboard) — which was the bug this fixes.
 */
// labelKey, not label: module scope cannot call t().
const TABS: Array<{ href: string; path: string; labelKey: string }> = [
  { href: '/agentbook/tax', path: '/', labelKey: 'tabs.dashboard' },
  { href: '/agentbook/tax-package', path: '/tax-package', labelKey: 'tabs.tax_package' },
  { href: '/agentbook/sales-tax-return', path: '/sales-tax-return', labelKey: 'tabs.gst_bas_return' },
];

export const TaxLayout: React.FC = () => {
  // Aliased: the map callback binds `t` (a tab), shadowing the translator.
  const { t: tr } = useI18n();
  const location = useLocation();

  return (
    <div>
      <div className="border-b border-border mb-4 flex gap-1">
        {TABS.map((t) => {
          const active = location.pathname === t.path;
          return (
            <a
              key={t.path}
              href={t.href}
              className={[
                'px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {tr(t.labelKey)}
            </a>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
};
