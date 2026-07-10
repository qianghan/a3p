import React from 'react';

/**
 * Page-level tab bar shared by ExpenseList and Bills — Bills is a sibling
 * top-level route within this plugin, not a separate sidebar destination.
 *
 * Plain <a> links, not react-router navigate(): each tab is its own
 * top-level /agentbook/* route (see the plugin's routes list in App.tsx),
 * so a real browser navigation is required for the URL, browser refresh,
 * and deep-links to all resolve to the right tab — mirrors the fix already
 * applied in agentbook-tax's TaxLayout.tsx for the same Dashboard/Tax
 * Package tab bar, which hit this same bug with client-only nav.
 */

const TABS = [
  { id: 'expenses' as const, label: 'Expenses', href: '/agentbook/expenses' },
  { id: 'bills' as const, label: 'Bills', href: '/agentbook/bills' },
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
