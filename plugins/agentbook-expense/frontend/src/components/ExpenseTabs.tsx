import React from 'react';

/**
 * Page-level tab bar shared by ExpenseList and Bills — Bills is a sibling
 * route within this plugin, not a separate sidebar destination.
 *
 * Plain <a> links, not react-router navigate(): each tab is its own
 * top-level route, so a real browser navigation is required for the URL,
 * browser refresh, and deep-links to all resolve to the right tab — mirrors
 * the fix already applied in agentbook-tax's TaxLayout.tsx for the same
 * Dashboard/Tax Package tab bar, which hit this same bug with client-only
 * nav. The Bills href is /agentbook/expenses/bills, NOT /agentbook/bills —
 * plugin.json's frontend.routes (the DB-backed registry the Next.js
 * catch-all page actually matches against) only registers
 * /agentbook/expenses/* for this plugin; /agentbook/bills isn't a
 * registered route and falls through to agentbook-core's /agentbook/*
 * wildcard instead. App.tsx's internal getInitialRoute() already handles
 * /agentbook/expenses/bills via its `path.includes('/bills')` check.
 */

const TABS = [
  { id: 'expenses' as const, label: 'Expenses', href: '/agentbook/expenses' },
  { id: 'bills' as const, label: 'Bills', href: '/agentbook/expenses/bills' },
];

export const ExpenseTabs: React.FC<{ active: 'expenses' | 'bills' }> = ({ active }) => {
  return (
    <div className="flex border-b border-border mb-5">
      {TABS.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
            active === t.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
};

export default ExpenseTabs;
