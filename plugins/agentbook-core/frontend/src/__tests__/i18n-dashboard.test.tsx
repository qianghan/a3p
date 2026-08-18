/**
 * Dashboard renders in every locale.
 *
 * The load-bearing assertion is "no raw key reaches the DOM". A missing
 * catalog entry does not throw — t() returns the key itself — so without this
 * a user would simply read `dashboard.this_month` on the page and nothing
 * would fail.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { AttentionPanel } from '../pages/dashboard/AttentionPanel';
import { NextMomentsList } from '../pages/dashboard/NextMomentsList';

/** A real translator over the real catalog — not a stub. */
function shellFor(locale: string): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n = {
    locale,
    t,
    formatMoney: (c: number) => String(c),
    formatCurrency: (c: number) => String(c),
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

/** Matches a dotted translation key, e.g. `dashboard.this_month`. */
const RAW_KEY = /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_.]+\b/;

describe.each(['en', 'fr-CA', 'zh-CN'])('dashboard panels in %s', (locale) => {
  it('AttentionPanel renders without leaking a raw key', () => {
    const { container } = render(
      <ShellProvider value={shellFor(locale)}>
        <AttentionPanel items={[]} summary={null} />
      </ShellProvider>,
    );
    const text = container.textContent ?? '';
    expect(RAW_KEY.test(text), `raw key leaked in ${locale}: ${text}`).toBe(false);
  });

  it('NextMomentsList renders its empty state without leaking a raw key', () => {
    const { container } = render(
      <ShellProvider value={shellFor(locale)}>
        <NextMomentsList moments={[]} />
      </ShellProvider>,
    );
    const text = container.textContent ?? '';
    expect(RAW_KEY.test(text), `raw key leaked in ${locale}: ${text}`).toBe(false);
  });
});

describe('dashboard copy actually differs by locale', () => {
  // Without this, every locale could be silently falling back to English and
  // the checks above would still pass — vacuously.
  it('renders French for fr-CA and English for en', () => {
    const en = render(
      <ShellProvider value={shellFor('en')}>
        <NextMomentsList moments={[]} />
      </ShellProvider>,
    );
    const enText = en.container.textContent ?? '';
    en.unmount();

    const fr = render(
      <ShellProvider value={shellFor('fr-CA')}>
        <NextMomentsList moments={[]} />
      </ShellProvider>,
    );
    const frText = fr.container.textContent ?? '';

    expect(enText).toContain('No upcoming receivables or bills.');
    expect(frText).toContain('Aucune créance ni facture à venir.');
    expect(frText).not.toBe(enText);
  });

  it('renders Chinese for zh-CN now that its content has landed', () => {
    // This asserted English while zh-CN was `scaffold`, written so it would
    // fail the day real content arrived rather than silently keep passing.
    // It did exactly that.
    const { container } = render(
      <ShellProvider value={shellFor('zh-CN')}>
        <NextMomentsList moments={[]} />
      </ShellProvider>,
    );
    expect(container.textContent).toContain('暂无待收款项或待付账单。');
    expect(container.textContent).not.toContain('No upcoming receivables');
  });
});
