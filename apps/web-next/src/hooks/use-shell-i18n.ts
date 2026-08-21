/**
 * Resolves the shell's locale ONCE and builds the translator injected into
 * ShellContext for every plugin.
 *
 * WHY ONCE, IN THE SHELL
 * The alternative — each plugin resolving its own locale — means six UMD
 * bundles each fetching tenant config and each carrying a copy of the catalog.
 * Resolving here keeps one catalog copy in the shell, adds nothing to any
 * plugin bundle, and guarantees every plugin on screen agrees on the language.
 *
 * PRECEDENCE  tenant config > navigator.language > 'en'
 * Tenant config wins because it is an explicit user choice; the browser header
 * is only a guess. Until the fetch resolves we serve the browser's guess rather
 * than blocking render, then re-render if the tenant's stored choice differs.
 *
 * The `t` returned here is bound to a locale at construction. There is no
 * setter, deliberately: a shared mutable locale is what leaked one user's
 * language into another user's response before this rewrite.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createTranslator,
  resolveLocale,
  formatCurrency,
  formatDate,
  formatDateOnly,
  formatNumber,
  formatPercent,
  parseAmountToCents,
} from '@agentbook/i18n';
// Catalog comes from the subpath: keeping it out of the main barrel is what
// stops all three locale packs being inlined into every plugin UMD bundle.
import { CATALOG, AVAILABLE_LOCALES } from '@agentbook/i18n/catalog';
/** Tenant config fields this hook needs. Matches `{ data: ... }` from the API. */
interface TenantLocaleConfig {
  locale?: string | null;
  currency?: string | null;
}

/**
 * Structural mirror of the SDK's `II18nService`.
 *
 * Declared locally rather than imported from '@naap/plugin-sdk' on purpose:
 * web-next's tsconfig includes only `plugin-sdk/src/components/*.tsx`, so
 * importing from the package root raises TS6307 ("not listed within the file
 * list of project"). Every other shell service (`IAuthService`, `IEventBus`,
 * ...) is declared locally in shell-context.tsx for the same reason — see the
 * "Full Shell Context matching plugin-sdk" comment there.
 *
 * The two definitions are kept in step by an architecture test that compares
 * their members, so drift fails CI rather than surfacing as a runtime gap.
 */
export interface ShellI18n {
  readonly locale: string;
  t(key: string, params?: Record<string, string | number>): string;
  formatMoney(amountCents: number, currency?: string): string;
  formatCurrency(amountCents: number, currency?: string): string;
  formatDate(date: string | Date, options?: Intl.DateTimeFormatOptions): string;
  formatDateOnly(date: string | Date, options?: Intl.DateTimeFormatOptions): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatPercent(value: number, decimals?: number): string;
  parseAmount(raw: string): { ok: boolean; cents: number; ambiguous: boolean; formatted: string };
  /** Tenant's currency, so money formatting doesn't need a second fetch. */
  readonly currency: string;
  /** False until tenant config has been read (or has failed). */
  readonly ready: boolean;
}

export function useShellI18n(): ShellI18n {
  const [config, setConfig] = useState<TenantLocaleConfig | null>(null);
  // Translation gate (decision D2). Starts FALSE so the very first render is
  // English even for a tenant stored as fr-CA — fail-closed, matching the
  // server-side reader.
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Response shape is `{ success, data }` — reading `.config` here instead of
    // `.data` is a mistake that has already shipped once on the Settings page.
    fetch('/api/v1/agentbook-core/tenant-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j?.data) setConfig(j.data as TenantLocaleConfig);
        setTranslationEnabled(j?.i18nLocalesEnabled === true);
      })
      .catch(() => {
        // A failed config fetch must not block the UI: fall through to the
        // browser locale rather than rendering nothing.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const locale = useMemo(
    () =>
      resolveLocale(
        {
          tenantLocale: config?.locale ?? null,
          // navigator.language stands in for Accept-Language on the client.
          acceptLanguage:
            typeof navigator !== 'undefined' ? navigator.language ?? null : null,
        },
        [...AVAILABLE_LOCALES],
      ),
    [config?.locale],
  );

  const currency = config?.currency || 'USD';

  // Keep <html lang> in step with the resolved locale. It drives screen-reader
  // pronunciation and CJK font selection — the same codepoint renders with
  // different glyphs under a Simplified vs Traditional font.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return useMemo(() => {
    // THE SPLIT: strings follow the flag, formatting follows the tenant.
    //
    // Formatting stays locale-correct unconditionally because those changes
    // are bug fixes already in production (a bill due date rendered a day
    // early west of UTC). Only translated STRINGS wait for the flag.
    //
    // Gating at resolution rather than at the picker is deliberate: a CA
    // tenant may already hold locale='fr-CA' from the old Canada-only
    // selector, so hiding the picker would not stop them seeing partial
    // French.
    const translationLocale = translationEnabled ? locale : 'en';
    const { t } = createTranslator(translationLocale, CATALOG);
    return {
      locale,
      currency,
      ready,
      t,
      // Both money formatters go through formatCurrency with the RESOLVED
      // USER LOCALE. The bare formatMoney() helper infers a display locale
      // from the currency code instead — that fallback exists for call sites
      // that hold a tenant `currency` and no locale at all, and using it here
      // was wrong: the shell has the locale, so inferring one threw it away.
      //
      // Concretely, for CAD: currency-inference gives en-CA "$1,234.56" to a
      // French-Canadian user, who should read "1 234,56 $". Every money figure
      // on every page reached through useI18n() was formatted in English.
      //
      // Note this is NOT behind the translation feature flag, deliberately.
      // Formatting follows the tenant locale unconditionally, because getting
      // it wrong is a correctness bug rather than a missing translation.
      formatMoney: (cents: number, cur: string = currency) =>
        formatCurrency(cents, locale, cur),
      formatCurrency: (cents: number, cur: string = currency) =>
        formatCurrency(cents, locale, cur),
      formatDate: (date: string | Date, options?: Intl.DateTimeFormatOptions) =>
        formatDate(date, locale, options),
      formatDateOnly: (date: string | Date, options?: Intl.DateTimeFormatOptions) =>
        formatDateOnly(date, locale, options),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(value, locale, options),
      formatPercent: (value: number, decimals?: number) =>
        formatPercent(value, locale, decimals),
      // Locale-aware form input. See II18nService.parseAmount for why
      // parseFloat(value) * 100 is a money bug on French input.
      parseAmount: (raw: string) => parseAmountToCents(raw, locale),
    };
  }, [locale, currency, ready, translationEnabled]);
}
