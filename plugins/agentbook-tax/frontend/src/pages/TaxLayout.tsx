import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';

/**
 * Shared tab bar for every Tax page (Dashboard, Quarterly, Deductions, Cash
 * Flow, Analytics, What-If, Reports, Tax Package). Before this, only the
 * Dashboard had a discoverable entry point — once a user followed a link
 * into e.g. Tax Package there was no way back to the rest of Tax. Plain
 * <a> links, not react-router <Link>: every tab is its own top-level
 * /agentbook/tax* route handled by the outer Next.js middleware rewrite, so
 * navigation between tabs is a full page load regardless.
 */
const TABS: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Dashboard' },
  { path: '/quarterly', label: 'Quarterly' },
  { path: '/deductions', label: 'Deductions' },
  { path: '/cashflow', label: 'Cash Flow' },
  { path: '/analytics', label: 'Analytics' },
  { path: '/whatif', label: 'What If' },
  { path: '/reports', label: 'Reports' },
  { path: '/tax-package', label: 'Tax Package' },
];

export const TaxLayout: React.FC = () => {
  const location = useLocation();

  return (
    <div>
      <div className="border-b border-border mb-4 flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const active = location.pathname === t.path;
          return (
            <a
              key={t.path}
              href={`/agentbook/tax${t.path === '/' ? '' : t.path}`}
              className={[
                'px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
            </a>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
};
