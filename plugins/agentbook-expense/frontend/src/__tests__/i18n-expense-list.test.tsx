/**
 * The migrated expense pages render in every locale.
 *
 * WHY THIS TEST EXISTS
 *
 * Everything else in the i18n suite checks the catalog: that keys exist in all
 * three locales, that placeholders match, that French carries its accents.
 * None of that proves a single translated word ever reaches a page. A key can
 * be present, correct, and beautifully translated while the component beside
 * it still renders a hardcoded English literal — which is exactly the bug
 * reported against the first cut of the language switcher: the picker changed,
 * the page did not.
 *
 * So this renders the real pages with a real translator over the real catalog
 * and asserts on the DOM. Two kinds of assertion per page, both load-bearing:
 *
 *   1. No raw key leaks. A missing catalog entry does not throw — t() returns
 *      the key — so a user would simply read `expenses_ui.col_vendor` on the
 *      page and no test would fail.
 *
 *   2. The copy actually differs by locale, checked on a specific known word.
 *      Without this, every locale could be silently falling back to English
 *      and assertion 1 would still pass, vacuously. This is the check that
 *      catches the reported bug: reverting a single t() call back to a
 *      hardcoded literal fails it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { withShell } from './i18n-harness';
import { ExpenseListPage } from '../pages/ExpenseList';
import { BankConnectionPage } from '../pages/BankConnection';
import { BudgetsPage } from '../pages/Budgets';
import { BillsPage } from '../pages/Bills';
import { MileagePage } from '../pages/Mileage';
import { PerDiemPage } from '../pages/PerDiem';
import { ReceiptsPage } from '../pages/Receipts';
import { VendorsPage } from '../pages/Vendors';
import { BankReviewPage } from '../pages/BankReview';
import { NewExpensePage } from '../pages/NewExpense';

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, exit: vi.fn() }),
}));

/**
 * Empty-but-well-shaped responses.
 *
 * Every shape below is copied from the route that serves it, with the route
 * named in a comment. The first draft returned a bare `{data: []}` for
 * /category-summary and the page crashed on `catData.data.categories`:
 * "empty" is not the same as "empty AND correctly shaped", and only the
 * latter tells you anything about the component.
 */
/**
 * One pending suggestion, so the categorization review banner actually renders.
 */
const pendingItems = [
  {
    expenseId: 'exp-1',
    vendorName: 'Staples',
    amountCents: 4599,
    suggestedCategoryId: 'cat-1',
    suggestedCategoryName: 'Office Supplies',
    confidence: 0.82,
    description: 'Printer paper',
  },
];

function installFetch() {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    let body: unknown;
    if (u.includes('/category-summary')) {
      // .../api/v1/agentbook-expense/category-summary/route.ts
      body = { success: true, data: { categories: [] } };
    } else if (u.includes('/auto-categorize/pending')) {
      // .../api/v1/agentbook-core/auto-categorize/pending/route.ts
      //
      // POPULATED, not empty — and that distinction cost a shipped crash. The
      // review banner returns null early when `items` is empty and
      // uncategorizedPct <= 10, so an empty fixture means the component never
      // renders. It contained a t() call with no binding, which threw
      // ReferenceError the moment a real user had a pending suggestion, and
      // every test passed because none of them ever rendered it.
      body = {
        success: true,
        data: {
          items: pendingItems,
          uncategorizedCount: pendingItems.length,
          totalCount: 10,
          uncategorizedPct: 40,
        },
      };
    } else if (u.includes('/mileage')) {
      // Shape copied from Mileage.test.tsx's summaryPayload(): the page reads
      // data.entries and data.summary, and the rate preview reads
      // summary.ytdByUnit per unit.
      body = {
        success: true,
        data: {
          entries: [],
          summary: {
            ytd: { miles: 0, deductibleCents: 0, entryCount: 0 },
            ytdByUnit: { mi: 0, km: 0 },
            monthly: [], byClient: [], byPurpose: [],
          },
        },
      };
    } else if (u.includes('/per-diem')) {
      body = { success: true, data: { entries: [] } };
    } else if (u.includes('/budgets')) {
      // Budgets.tsx reads `data.budgets`, not `data`.
      body = { success: true, data: { budgets: [] } };
    } else if (u.includes('/tenant-config')) {
      body = { data: { currency: 'CAD', jurisdiction: 'ca' } };
    } else {
      body = { success: true, data: [] };
    }
    return Promise.resolve({ ok: true, json: async () => body } as any);
  }) as any;
}

/**
 * Every migrated page, with one word that must be translated on each. Specific
 * words rather than a whole-string inequality, so the check cannot pass on
 * incidental whitespace drift.
 */
const PAGES: Array<{ name: string; el: React.ReactElement; en: string; fr: string; zh: string }> = [
  { name: 'ExpenseList', el: <ExpenseListPage />, en: 'Vendor', fr: 'Fournisseur', zh: '商家' },
  {
    name: 'BankConnection',
    el: <BankConnectionPage />,
    en: 'No banks connected yet', fr: 'Aucune banque connectée', zh: '尚未连接银行',
  },
  { name: 'Budgets', el: <BudgetsPage />, en: 'New Budget', fr: 'Nouveau budget', zh: '新建预算' },
  { name: 'Bills', el: <BillsPage />, en: 'Overdue', fr: 'En retard', zh: '逾期' },
  { name: 'Mileage', el: <MileagePage />, en: 'Recent trips', fr: 'Trajets récents', zh: '近期行程' },
  {
    name: 'PerDiem',
    el: <PerDiemPage />,
    en: 'Book per-diem', fr: 'Enregistrer l’indemnité', zh: '登记每日津贴',
  },
  { name: 'Receipts', el: <ReceiptsPage />, en: 'Receipts', fr: 'Reçus', zh: '收据' },
  { name: 'Vendors', el: <VendorsPage />, en: 'Vendors', fr: 'Fournisseurs', zh: '商家' },
  {
    name: 'BankReview',
    el: <BankReviewPage />,
    en: 'All caught up', fr: 'Tout est à jour', zh: '全部已处理',
  },
  {
    name: 'NewExpense',
    el: <NewExpensePage />,
    en: 'Record Expense', fr: 'Enregistrer une dépense', zh: '记录支出',
  },
];

async function renderAt(el: React.ReactElement, locale: string): Promise<string> {
  const { container } = render(<MemoryRouter>{withShell(el, locale)}</MemoryRouter>);
  // Two conditions, and the non-emptiness one is not optional. An earlier
  // version waited only for the absence of a loading word, which an EMPTY
  // container satisfies instantly — so it returned '' before first content
  // paint, and the "no raw key leaked" assertion passed vacuously on a blank
  // page. A blank render is a failure, not a pass.
  await waitFor(() => {
    const text = container.textContent ?? '';
    expect(text.length, 'page rendered nothing').toBeGreaterThan(20);
    expect(text).not.toMatch(/Loading|Chargement|正在加载/);
  });
  return container.textContent ?? '';
}

/** Matches a dotted translation key that escaped into the DOM. */
const RAW_KEY = /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]{2,}\b/;

beforeEach(() => {
  installFetch();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PAGES)('$name in every locale', (page) => {
  it.each(['en', 'fr-CA', 'zh-CN'])('renders in %s without leaking a raw key', async (locale) => {
    const text = await renderAt(page.el, locale);
    expect(RAW_KEY.exec(text)?.[0], `raw key leaked in ${locale}`).toBeUndefined();
  });

  it('renders French rather than English for fr-CA', async () => {
    const en = await renderAt(page.el, 'en');
    const fr = await renderAt(page.el, 'fr-CA');
    expect(en).toContain(page.en);
    expect(fr).toContain(page.fr);
  });

  it('renders Chinese for zh-CN', async () => {
    const zh = await renderAt(page.el, 'zh-CN');
    expect(zh).toContain(page.zh);
    // Guards against a locale that is structurally present but empty.
    expect(/[一-鿿]/.test(zh)).toBe(true);
  });
});
