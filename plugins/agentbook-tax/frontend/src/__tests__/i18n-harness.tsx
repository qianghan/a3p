/**
 * A shell context carrying a REAL translator over the REAL catalog, for tests
 * that render plugin pages.
 *
 * Two reasons this exists rather than each test stubbing i18n itself:
 *
 * 1. `useI18n()` outside a ShellProvider falls back to humanising the key —
 *    `expenses_ui.connect_with_basiq` renders as "Connect with basiq", with a
 *    lowercase brand name. That fallback is a safety net, not a translation
 *    source, and it is lossy. A test that renders bare is therefore asserting
 *    against mangled English that no user ever sees, since every plugin page
 *    in production is mounted inside the shell. Wrapping in this provider
 *    makes such tests prod-faithful.
 *
 * 2. A stubbed `t` that echoes its key would let a page test pass against a
 *    catalog with no French in it at all. Using the real translator means the
 *    assertions are about what actually renders.
 *
 * The FORMATTERS are stubs on purpose. They have their own unit tests, and
 * their locale-dependent output would otherwise make "does this page differ
 * between locales?" pass for the wrong reason — French renders 1234.5 as
 * "1 234,5", so any page containing a number differs between locales even
 * with zero translated strings.
 */
import React from 'react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

export function shellFor(locale: string): ShellContext {
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
