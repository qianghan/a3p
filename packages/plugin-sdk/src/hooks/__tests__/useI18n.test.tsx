/**
 * useI18n — the version-skew degrade path.
 *
 * The scenario under test is specific and real: plugin bundles are served from
 * a CDN and versioned independently of the shell, so a NEWER plugin can run
 * against an OLDER shell that injects no `i18n`. If the hook threw there, a
 * missing translation layer would take down the whole page.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShellProvider } from '../useShell.js';
import { useI18n, useLocale } from '../useI18n.js';
import type { ShellContext, II18nService } from '../../types/services.js';

/** Minimal ShellContext with only what the provider requires. */
function makeShell(i18n?: II18nService): ShellContext {
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
    ...(i18n ? { i18n } : {}),
  } as ShellContext;
}

function Probe() {
  const { t, formatMoney, formatPercent } = useI18n();
  const locale = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="key">{t('expense.receipt_saved')}</span>
      <span data-testid="interp">{t('expense.saved_for', { amount: '$45.00' })}</span>
      <span data-testid="money">{formatMoney(4500, 'USD')}</span>
      <span data-testid="pct">{formatPercent(0.283)}</span>
    </div>
  );
}

const injected: II18nService = {
  locale: 'fr-CA',
  t: (key, params) =>
    key === 'expense.receipt_saved'
      ? 'Reçu enregistré'
      : `${key}:${JSON.stringify(params ?? {})}`,
  formatMoney: () => '45,00 $',
  formatCurrency: () => '45,00 $',
  formatDate: () => '22 mars 2026',
  formatNumber: () => '1 234,56',
  formatPercent: () => '28,3 %',
};

describe('useI18n with an injected service', () => {
  it('uses the shell-provided translator', () => {
    render(
      <ShellProvider value={makeShell(injected)}>
        <Probe />
      </ShellProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('fr-CA');
    expect(screen.getByTestId('key').textContent).toBe('Reçu enregistré');
    expect(screen.getByTestId('money').textContent).toBe('45,00 $');
    expect(screen.getByTestId('pct').textContent).toBe('28,3 %');
  });
});

describe('useI18n degrade path: older shell injects no i18n', () => {
  it('renders instead of crashing', () => {
    expect(() =>
      render(
        <ShellProvider value={makeShell(undefined)}>
          <Probe />
        </ShellProvider>,
      ),
    ).not.toThrow();
  });

  it('falls back to English rather than showing a raw key', () => {
    render(
      <ShellProvider value={makeShell(undefined)}>
        <Probe />
      </ShellProvider>,
    );
    // 'expense.receipt_saved' humanises to 'Receipt saved'. Not the exact
    // product copy, but words rather than a dotted key.
    expect(screen.getByTestId('key').textContent).toBe('Receipt saved');
    expect(screen.getByTestId('key').textContent).not.toContain('.');
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });

  it('still interpolates params in the fallback', () => {
    render(
      <ShellProvider value={makeShell(undefined)}>
        <Probe />
      </ShellProvider>,
    );
    // The humanised key has no {amount} placeholder, so interpolation is a
    // no-op here — the assertion is that it does not emit "[object Object]"
    // or leak the JSON of the params.
    const txt = screen.getByTestId('interp').textContent ?? '';
    expect(txt).not.toContain('[object');
    expect(txt).not.toContain('{"amount"');
  });

  it('still formats money and percentages in the fallback', () => {
    render(
      <ShellProvider value={makeShell(undefined)}>
        <Probe />
      </ShellProvider>,
    );
    // Real Intl output, not a placeholder string.
    expect(screen.getByTestId('money').textContent).toBe('$45.00');
    expect(screen.getByTestId('pct').textContent).toBe('28.3%');
  });

  it('picks the currency-implied locale in the fallback formatter', () => {
    function CurrencyProbe() {
      const { formatMoney } = useI18n();
      return <span data-testid="aud">{formatMoney(4500, 'AUD')}</span>;
    }
    render(
      <ShellProvider value={makeShell(undefined)}>
        <CurrencyProbe />
      </ShellProvider>,
    );
    // en-AU renders AUD as "$45.00" — the assertion is that an unknown-to-en-US
    // currency does not fall through to the "AUD 45.00" error branch.
    expect(screen.getByTestId('aud').textContent).not.toContain('AUD 45.00');
  });
});

describe('useI18n outside a ShellProvider', () => {
  // Originally this threw, "consistent with useAuthService and friends". That
  // was wrong: those services have no fallback, so a missing provider is fatal
  // for them. i18n HAS a working English fallback, and throwing discarded it.
  //
  // The cost was immediate — adding useI18n to a component broke its existing
  // tests, which render it bare with no provider (seven render calls in one
  // suite). Across ~26 pages of string extraction that is a standing incentive
  // to skip i18n or rewrite unrelated tests.
  it('renders English instead of throwing', () => {
    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByTestId('key').textContent).toBe('Receipt saved');
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });

  it('still formats money and percentages with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('money').textContent).toBe('$45.00');
    expect(screen.getByTestId('pct').textContent).toBe('28.3%');
  });

  it('leaves the other SDK hooks throwing, which is correct for them', async () => {
    // Guard against someone generalising this change: a missing auth service
    // must still fail loudly, because there is nothing to fall back to.
    const { useShell } = await import('../useShell.js');
    function AuthProbe() {
      useShell();
      return null;
    }
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<AuthProbe />)).toThrow(/ShellProvider/);
    } finally {
      console.error = spy;
    }
  });
});
