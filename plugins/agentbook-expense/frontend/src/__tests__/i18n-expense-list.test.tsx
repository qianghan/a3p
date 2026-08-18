/**
 * The expense list renders in every locale.
 *
 * WHY THIS TEST EXISTS
 *
 * Everything else in the i18n suite checks the catalog: that keys exist in
 * all three locales, that placeholders match, that French carries its
 * accents. None of that proves a single translated word ever reaches a page.
 * A key can be present, correct, and beautifully translated while the
 * component next to it still renders a hardcoded English literal — which is
 * exactly the bug reported against the first cut of the language switcher:
 * the picker changed, the page did not.
 *
 * So this test renders the real ExpenseList with a real translator over the
 * real catalog and asserts on the DOM.
 *
 * Two assertions, and both are load-bearing:
 *
 *   1. No raw key leaks. A missing catalog entry does not throw — t() returns
 *      the key — so a user would simply read `expenses_ui.col_vendor` on the
 *      page and no test would fail.
 *
 *   2. The copy actually differs between locales. Without this, every locale
 *      could be silently falling back to English and assertion 1 would still
 *      pass, vacuously. This is the check that would have caught the
 *      reported bug.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { ExpenseListPage } from '../pages/ExpenseList';

/**
 * A real translator over the real catalog — deliberately not a stub. A stub
 * would let this test pass against a catalog that has no French in it.
 *
 * The formatters are stubs, because they are covered by their own unit tests
 * and their output would otherwise make the locale-difference assertion pass
 * for the wrong reason (French formats 1234.5 as "1 234,5", so a page
 * containing any number would differ between locales even with zero
 * translated strings).
 */
function shellFor(locale: string): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n = {
    locale,
    t,
    formatMoney: (c: number) => `$${c}`,
    formatCurrency: (c: number) => `$${c}`,
    formatDate: (d: string | Date) => String(d),
    formatDateOnly: (d: string | Date) => String(d),
    formatNumber: (n: number) => String(n),
    formatPercent: (n: number) => String(n),
    parseAmount: () => ({ ok: true, cents: 0, ambiguous: false, formatted: '' }),
  } as II18nService;
  return {
    auth: {}, navigate: () => {}, eventBus: {}, theme: {}, notifications: {},
    integrations: {}, logger: {}, permissions: {}, version: '2.0.0', i18n,
  } as unknown as ShellContext;
}

/**
 * Empty-but-well-shaped responses on every endpoint.
 *
 * The shapes here are copied from the real routes, not invented. The first
 * draft of this mock returned `{data: []}` for /category-summary, and the page
 * crashed on `catData.data.categories` — a mock that is merely "empty" is not
 * the same as a mock that is empty AND correctly shaped, and only the latter
 * tells you anything about the component.
 *
 * The empty state is the right surface to assert on: it is deterministic, and
 * it renders the column headers, the search placeholder, the empty-state copy
 * and the bank-connection CTA — most of the strings this page owns.
 */
function installFetch() {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    // Each shape below is copied from the route that serves it.
    let body: unknown;
    if (u.includes('/category-summary')) {
      // .../api/v1/agentbook-expense/category-summary/route.ts
      body = { success: true, data: { categories: [] } };
    } else if (u.includes('/auto-categorize/pending')) {
      // .../api/v1/agentbook-core/auto-categorize/pending/route.ts
      body = {
        success: true,
        data: { items: [], uncategorizedCount: 0, totalCount: 0, uncategorizedPct: 0 },
      };
    } else if (u.includes('/tenant-config')) {
      body = { data: { currency: 'CAD', jurisdiction: 'ca' } };
    } else {
      body = { success: true, data: [] };
    }
    return Promise.resolve({ ok: true, json: async () => body } as any);
  }) as any;
}

async function renderAt(locale: string): Promise<string> {
  const { container } = render(
    <MemoryRouter>
      <ShellProvider value={shellFor(locale)}>
        <ExpenseListPage />
      </ShellProvider>
    </MemoryRouter>,
  );
  // Without this we assert on the loading spinner and never reach the
  // column headers and empty-state copy that carry most of the strings.
  await waitFor(() => {
    expect(container.textContent ?? '').not.toMatch(/Loading|Chargement|正在加载/);
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

describe.each(['en', 'fr-CA', 'zh-CN'])('ExpenseList in %s', (locale) => {
  it('renders without leaking a raw translation key', async () => {
    const text = await renderAt(locale);
    const leak = RAW_KEY.exec(text);
    expect(leak?.[0], `raw key leaked in ${locale}`).toBeUndefined();
  });
});

describe('ExpenseList copy actually changes with the locale', () => {
  it('renders French, not English, for fr-CA', async () => {
    const en = await renderAt('en');
    const fr = await renderAt('fr-CA');
    expect(fr).not.toBe(en);
    // A specific word, so this cannot pass on incidental whitespace drift.
    expect(en).toContain('Vendor');
    expect(fr).toContain('Fournisseur');
    expect(fr).not.toContain('Vendor');
  });

  it('renders Chinese, not English, for zh-CN', async () => {
    const zh = await renderAt('zh-CN');
    expect(zh).toContain('商家'); // vendor
    expect(zh).not.toContain('Vendor');
    // Guards against a locale that is structurally present but empty.
    expect(/[一-鿿]/.test(zh)).toBe(true);
  });
});
