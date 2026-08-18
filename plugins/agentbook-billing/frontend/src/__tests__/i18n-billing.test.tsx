/**
 * Billing UI renders correctly in every locale.
 *
 * The load-bearing assertion is "no raw key reaches the DOM". A missing
 * catalog entry does not throw — `t()` returns the key itself — so without
 * this check a user would simply read `billing.current_plan` on the page and
 * nothing would fail.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { UsageBars } from '../user/UsageBars';

/** A real translator over the real catalog — not a stub. */
function shellFor(locale: string): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n: II18nService = {
    locale,
    t,
    formatMoney: (c) => String(c),
    formatCurrency: (c) => String(c),
    formatDate: (d) => String(d),
    formatDateOnly: (d) => String(d),
    formatNumber: (n) => String(n),
    formatPercent: (n) => String(n),
    parseAmount: () => ({ ok: true, cents: 0, ambiguous: false, formatted: '' }),
  };
  return {
    auth: {} as never,
    navigate: () => {},
    eventBus: {} as never,
    theme: {} as never,
    notifications: {} as never,
    integrations: {} as never,
    logger: {} as never,
    permissions: {} as never,
    version: '2.0.0',
    i18n,
  } as ShellContext;
}

const USAGE = {
  expenses_created: { used: 12, limit: 100 },
  ai_messages: { used: 5, limit: -1 },
};

/** Matches a dotted translation key, e.g. `billing.current_plan`. */
const RAW_KEY = /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_.]+\b/;

describe.each(['en', 'fr-CA', 'zh-CN'])('UsageBars in %s', (locale) => {
  it('renders without leaking a raw translation key', () => {
    const { container } = render(
      <ShellProvider value={shellFor(locale)}>
        <UsageBars usage={USAGE} />
      </ShellProvider>,
    );
    const text = container.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(RAW_KEY.test(text), `raw key leaked in ${locale}: ${text}`).toBe(false);
  });

  it('renders the unlimited label as words, not -1', () => {
    render(
      <ShellProvider value={shellFor(locale)}>
        <UsageBars usage={USAGE} />
      </ShellProvider>,
    );
    // -1 is the sentinel for "no limit" and must never be shown to a user.
    expect(screen.queryByText(/-1/)).toBeNull();
  });
});

describe('UsageBars actually differs by locale', () => {
  // Guards against the whole suite passing because every locale silently fell
  // back to English — which would make the checks above vacuous.
  it('shows French copy for fr-CA and English for en', () => {
    const en = render(
      <ShellProvider value={shellFor('en')}>
        <UsageBars usage={USAGE} />
      </ShellProvider>,
    );
    const enText = en.container.textContent ?? '';
    en.unmount();

    const fr = render(
      <ShellProvider value={shellFor('fr-CA')}>
        <UsageBars usage={USAGE} />
      </ShellProvider>,
    );
    const frText = fr.container.textContent ?? '';

    expect(enText).toContain('Expenses created');
    expect(enText).toContain('Unlimited');
    expect(frText).toContain('Dépenses créées');
    expect(frText).toContain('Illimité');
    expect(frText).not.toBe(enText);
  });

  it('renders Chinese for zh-CN now that its content has landed', () => {
    // Asserted English while zh-CN was `scaffold`; written to fail the day
    // real content arrived rather than silently keep passing.
    const { container } = render(
      <ShellProvider value={shellFor('zh-CN')}>
        <UsageBars usage={USAGE} />
      </ShellProvider>,
    );
    expect(container.textContent).toContain('已创建支出');
    expect(container.textContent).toContain('无限制');
    expect(container.textContent).not.toContain('Expenses created');
  });
});
