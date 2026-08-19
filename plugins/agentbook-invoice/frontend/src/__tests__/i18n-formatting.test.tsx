/**
 * Invoice pages format money and dates in the READER's locale.
 *
 * WHY THIS TEST EXISTS
 *
 * Five files in this plugin had a module-level formatter that passed a literal
 * 'en-US' to Intl.NumberFormat / toLocaleDateString. Every invoice total, every
 * due date, and every estimate amount rendered in US format regardless of how
 * the tenant was configured — so a Quebec freelancer read "$1,234.56" where the
 * correct rendering is "1 234,56 $".
 *
 * That is worth its own test rather than folding into the string-extraction
 * ones, for a reason specific to this codebase: formatting is deliberately NOT
 * behind the i18n feature flag. Translated strings wait for the rollout;
 * formatting follows the tenant locale unconditionally, because getting it
 * wrong is a correctness bug and not a missing feature. So these assertions
 * must hold with the flag in either state, and a test that conflated the two
 * would not say that.
 *
 * The plugin had NO tests at all before this file, which is how six such call
 * sites accumulated unnoticed.
 *
 * Asserting on rendered OUTPUT, not on which function got called: the whole
 * failure mode here was a formatter that ran perfectly well and produced the
 * wrong string.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import {
  createTranslator,
  formatCurrency,
  formatDate,
  formatDateOnly,
  formatNumber,
  formatPercent,
} from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { InvoiceListPage } from '../pages/InvoiceList';

/**
 * A shell whose formatters are the REAL ones, bound to `locale` exactly as
 * apps/web-next/src/hooks/use-shell-i18n.ts binds them.
 *
 * Stubbing the formatters here would defeat the entire point of the file —
 * the bug under test lived in which locale reached Intl, so a stub that
 * returned a fixed string would pass against the broken code.
 */
function shellFor(locale: string, currency = 'CAD'): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n = {
    locale,
    t,
    // Both money entry points go through formatCurrency with the RESOLVED
    // locale, matching the shell. The bare formatMoney() helper infers a
    // locale from the currency code instead, which is what produced en-CA
    // output for a fr-CA reader.
    formatMoney: (c: number, cur: string = currency) => formatCurrency(c, locale, cur),
    formatCurrency: (c: number, cur: string = currency) => formatCurrency(c, locale, cur),
    formatDate: (d: string | Date, o?: Intl.DateTimeFormatOptions) => formatDate(d, locale, o),
    formatDateOnly: (d: string | Date, o?: Intl.DateTimeFormatOptions) =>
      formatDateOnly(d, locale, o),
    formatNumber: (n: number, o?: Intl.NumberFormatOptions) => formatNumber(n, locale, o),
    formatPercent: (n: number, dp?: number) => formatPercent(n, locale, dp),
    parseAmount: () => ({ ok: true as const, cents: 0, ambiguous: false, formatted: '' }),
  } as II18nService;
  return {
    auth: {}, navigate: () => {}, eventBus: {}, theme: {}, notifications: {},
    integrations: {}, logger: {}, permissions: {}, version: '2.0.0', i18n,
  } as unknown as ShellContext;
}

/**
 * The row carries its OWN currency — InvoiceList formats each invoice with
 * `inv.currency`, not the tenant default — so the fixture's currency has to
 * change alongside the shell's, or the two disagree and the assertion tests
 * nothing it means to.
 */
function invoiceRow(currency: string) {
  return {
    id: 'inv-1',
    number: 'INV-0001',
    client: { name: 'Acme Inc' },
    amountCents: 123456,
    currency,
    dueDate: '2026-03-22',
    status: 'sent' as const,
  };
}

function installFetch(currency = 'CAD') {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    const body = u.includes('/invoices')
      ? { invoices: [invoiceRow(currency)] }
      : { success: true, data: [] };
    return Promise.resolve({ ok: true, json: async () => body } as any);
  }) as any;
}

async function renderAt(locale: string, currency = 'CAD'): Promise<string> {
  installFetch(currency);
  const { container } = render(
    <MemoryRouter>
      <ShellProvider value={shellFor(locale, currency)}>
        <InvoiceListPage />
      </ShellProvider>
    </MemoryRouter>,
  );
  // Wait for the fetched row to land. A bare "not loading" check would pass on
  // an empty container and assert nothing.
  await waitFor(() => expect(container.textContent ?? '').toContain('INV-0001'));
  return container.textContent ?? '';
}

beforeEach(() => installFetch());
afterEach(() => vi.restoreAllMocks());

describe('invoice amounts follow the reader locale', () => {
  it('renders US formatting for en-US', async () => {
    expect(await renderAt('en-US')).toContain('$1,234.56');
  });

  it('renders French-Canadian formatting for fr-CA — the regression', async () => {
    const text = await renderAt('fr-CA');
    // The exact string the bug produced. Naming it means this test fails for
    // the right reason rather than on any incidental difference.
    expect(text).not.toContain('$1,234.56');
    // French: comma decimal separator, symbol trailing, non-breaking space as
    // the group separator (hence \s rather than a literal space).
    expect(text).toMatch(/1\s*234,56\s*\$/);
  });

  it('renders Chinese formatting for zh-CN', async () => {
    // MUST use a currency where zh-CN and en-US differ. For CAD they are
    // byte-identical ("CA$1,234.56"), so an assertion on CAD passes against
    // the hardcoded-'en-US' code and proves nothing — confirmed by reverting
    // the fix and watching this test stay green. CNY discriminates: zh-CN
    // gives "¥", en-US gives "CN¥".
    const text = await renderAt('zh-CN', 'CNY');
    expect(text).not.toContain('CN¥');
    expect(text).toMatch(/¥1,234\.56/);
  });

  it('the MONEY specifically differs between en-US and fr-CA', async () => {
    // Deliberately narrowed. A whole-page inequality passed against the broken
    // code, because the due DATE was already locale-aware and differed on its
    // own — so the guard was satisfied without money being correct at all.
    const money = (text: string) => text.match(/(?:CA\$|US\$)?[\d\s,.]*\d[,.]\d\d\s*\$?/)?.[0];
    expect(money(await renderAt('en-US'))).not.toBe(money(await renderAt('fr-CA')));
  });
});

describe('invoice STRINGS are translated too, not only the numbers', () => {
  // The formatting assertions above would all pass on a page whose every label
  // was still hardcoded English, so they say nothing about extraction. These
  // do. Specific words, so the check cannot pass on whitespace drift.
  it('renders French labels for fr-CA', async () => {
    const text = await renderAt('fr-CA');
    expect(text).toContain('Factures');
    expect(text).toContain('Total impayé');
    expect(text).not.toContain('Total Outstanding');
  });

  it('renders Chinese labels for zh-CN', async () => {
    const text = await renderAt('zh-CN');
    expect(text).toContain('发票');
    expect(text).toContain('未收款总额');
    expect(text).not.toContain('Total Outstanding');
  });

  it('leaks no raw translation key in any locale', async () => {
    // t() returns the key on a miss rather than throwing, so without this a
    // user would simply read `invoice_ui.total_outstanding` on the page.
    const RAW_KEY = /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]{2,}\b/;
    for (const locale of ['en-US', 'fr-CA', 'zh-CN']) {
      const text = await renderAt(locale);
      expect(RAW_KEY.exec(text)?.[0], `raw key leaked in ${locale}`).toBeUndefined();
    }
  });
});

describe('due dates are logical calendar days, formatted in UTC', () => {
  it('does not render the previous day west of UTC', async () => {
    // 2026-03-22 parses as UTC midnight; local-time formatting in any negative
    // offset renders "Mar 21". This is the shipped bug formatDateOnly fixes,
    // asserted on the page rather than only in the formatter's own unit test.
    const text = await renderAt('en-US');
    expect(text).toContain('22');
    expect(text).not.toMatch(/Mar 21|March 21/);
  });
});
