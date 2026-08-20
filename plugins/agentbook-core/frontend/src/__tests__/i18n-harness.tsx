/**
 * A shell context carrying a REAL translator over the REAL catalog, for tests
 * that render core plugin components.
 *
 * Mirrors plugins/agentbook-expense/frontend/src/__tests__/i18n-harness.tsx —
 * see that file for the full reasoning. The short version:
 *
 *   useI18n() outside a ShellProvider falls back to HUMANISING the key, so
 *   `core_ui.abbr_revenue` renders as "Abbr revenue". A test rendering bare
 *   therefore asserts against mangled English that no user ever sees, since
 *   every core page in production is mounted inside the shell.
 *
 * That is not hypothetical here: ThisMonthStrip's test asserted getByText(/Rev/)
 * and started failing the moment its label became a t() call, because the
 * fallback produced "Abbr revenue" — capital A, lowercase r. The test was right
 * to fail; it was asserting on a path production never takes.
 *
 * The FORMATTERS are stubs on purpose: they have their own unit tests, and
 * their locale-dependent output would make "does this differ between locales?"
 * pass for the wrong reason.
 */
import React from 'react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

export function shellFor(locale: string, currency = 'USD'): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n = {
    locale,
    t,
    formatMoney: (c: number) => `$${(c / 100).toFixed(2)}`,
    formatCurrency: (c: number) => `$${(c / 100).toFixed(2)}`,
    formatDate: (d: string | Date) => String(d),
    formatDateOnly: (d: string | Date) => String(d),
    formatNumber: (n: number) => String(n),
    formatPercent: (n: number) => String(n),
    parseAmount: (raw: string) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n)
        ? { ok: true as const, cents: Math.round(n * 100), ambiguous: false, formatted: raw }
        : { ok: false as const, cents: 0, ambiguous: false, formatted: raw };
    },
  } as II18nService;
  return {
    auth: {}, navigate: () => {}, eventBus: {}, theme: {}, notifications: {},
    integrations: {}, logger: {}, permissions: {}, version: '2.0.0', i18n,
  } as unknown as ShellContext;
}

/** Wraps children in a shell at `locale` (default English). */
export function withShell(children: React.ReactNode, locale = 'en'): React.ReactElement {
  return <ShellProvider value={shellFor(locale)}>{children}</ShellProvider>;
}
