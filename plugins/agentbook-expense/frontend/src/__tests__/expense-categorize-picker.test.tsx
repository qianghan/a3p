import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { withShell } from './i18n-harness';
import { ExpenseListPage } from '../pages/ExpenseList';

/**
 * A tenant whose only expense is uncategorized could never categorize it
 * from the row picker: `categoryOptions` was derived from `/category-summary`,
 * which only lists categories ALREADY used by existing expenses. With zero
 * categorized expenses there was nothing to seed the list, so
 * `categoryOptions` was permanently `[]` and the select stayed disabled
 * forever — regardless of how many categories exist in the chart of
 * accounts. Reported live: a user with exactly one expense, "Uncategorized",
 * select disabled, chat categorization also not landing.
 *
 * Fix: the picker now sources its options from
 * `GET /api/v1/agentbook-core/accounts?type=expense` (the tenant's real
 * chart of accounts), independent of whether any expense has used them yet.
 */

const EXPENSE_ACCOUNTS = [
  { id: 'acc-office', tenantId: 't1', code: '5010', name: 'Office Supplies', accountType: 'expense', isActive: true },
  { id: 'acc-software', tenantId: 't1', code: '5020', name: 'Software', accountType: 'expense', isActive: true },
];

const ONE_UNCATEGORIZED_EXPENSE = {
  id: 'exp-1',
  amountCents: 4599,
  taxAmountCents: 0,
  tipAmountCents: 0,
  description: 'Printer paper',
  notes: null,
  date: '2026-09-15',
  categoryId: null,
  categoryName: null,
  categoryCode: null,
  vendorId: 'v1',
  vendorName: 'Staples',
  receiptUrl: null,
  paymentMethod: 'card',
  currency: 'USD',
  tags: null,
  confidence: null,
  isPersonal: false,
  isBillable: false,
  journalEntryId: null,
  deletedAt: null,
};

function installFetch() {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    let body: unknown;
    if (u.includes('/agentbook-expense/expenses')) {
      body = { success: true, data: [ONE_UNCATEGORIZED_EXPENSE] };
    } else if (u.includes('/category-summary')) {
      // Exactly what /category-summary returns for a tenant whose only
      // expense is uncategorized: one bucket, categoryId null.
      body = {
        success: true,
        data: {
          categories: [
            { categoryId: null, categoryName: 'Uncategorized', totalCents: 4599, count: 1, previousPeriodCents: 0, changePercent: null, topVendors: [] },
          ],
        },
      };
    } else if (u.includes('/agentbook-core/accounts')) {
      // The real chart of accounts — populated even though nothing has used
      // these categories yet. This is the data the old code never fetched.
      body = { success: true, data: EXPENSE_ACCOUNTS };
    } else if (u.includes('/auto-categorize/pending')) {
      body = { success: true, data: { items: [], uncategorizedCount: 0, totalCount: 1, uncategorizedPct: 100 } };
    } else if (u.includes('/tenant-config')) {
      body = { data: { currency: 'USD', jurisdiction: 'us' } };
    } else {
      body = { success: true, data: [] };
    }
    return Promise.resolve({ ok: true, json: async () => body } as any);
  }) as any;
}

beforeEach(() => {
  installFetch();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExpenseList categorize picker — tenant with a single uncategorized expense', () => {
  it('renders the category select ENABLED and populated from the chart of accounts, not disabled', async () => {
    render(<MemoryRouter>{withShell(<ExpenseListPage />)}</MemoryRouter>);

    const select = await waitFor(() => {
      const el = document.querySelector('select') as HTMLSelectElement | null;
      expect(el, 'no category select rendered for the uncategorized row').not.toBeNull();
      return el!;
    });

    // The bug: this used to be permanently true (categoryOptions === []).
    expect(select.disabled).toBe(false);

    const optionNames = Array.from(select.options).map((o) => o.textContent);
    expect(optionNames).toEqual(expect.arrayContaining(['Office Supplies', 'Software']));
  });

  it('picking a category actually assigns it — POSTs the real accountId, not a stale/empty value', async () => {
    render(<MemoryRouter>{withShell(<ExpenseListPage />)}</MemoryRouter>);

    const select = await waitFor(() => {
      const el = document.querySelector('select') as HTMLSelectElement | null;
      expect(el).not.toBeNull();
      return el!;
    });

    fireEvent.change(select, { target: { value: 'acc-office' } });

    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/categorize'));
      expect(call, 'no categorize request was sent').toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.categoryId).toBe('acc-office');
    });
  });
});
