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
  DEFAULT_LOCALE,
  formatCurrency,
  formatDate,
  formatDateOnly,
  formatNumber,
  formatPercent,
  parseAmountToCents,
} from '@agentbook/i18n';
// Catalog comes from a subpath: keeping it out of the main barrel is what
// stops all three locale packs being inlined into every plugin UMD bundle.
//
// And specifically the CLIENT subpath. This import is the one that decides the
// weight of every page in the product: it sits in ShellProvider, which the
// root layout renders, so whatever it pulls in is in every route's First Load
// JS. '/catalog' would add the server-only namespaces — 36 kB gzipped of
// Telegram and agent-skill copy that no browser can render — because nothing
// tree-shakes a catalog. See catalog-client.ts.
//
// AVAILABLE_LOCALES comes from the same place deliberately. The version in
// '/catalog' is Object.keys(CATALOG), so importing it retains the full catalog
// and undoes the whole saving; a first attempt at this split kept that one
// import and every route got BIGGER.
import {
  CLIENT_CATALOG as STATIC_CATALOG,
  AVAILABLE_LOCALES,
  loadLocalePack,
} from '@agentbook/i18n/catalog-client';
import type { Catalog } from '@agentbook/i18n';
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
  /**
   * False until translation has settled: tenant config read (or failed) AND,
   * for a non-English locale, its pack loaded (or failed). Both halves matter
   * — a consumer that rendered on `ready` when only the config had arrived
   * would paint English and then swap to French a moment later.
   */
  readonly ready: boolean;
}

export function useShellI18n(): ShellI18n {
  const [config, setConfig] = useState<TenantLocaleConfig | null>(null);
  // Translation gate (decision D2). Starts FALSE so the very first render is
  // English even for a tenant stored as fr-CA — fail-closed, matching the
  // server-side reader.
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [configRead, setConfigRead] = useState(false);
  /**
   * The packs in hand. Starts as the static catalog, which is `en` only; a
   * non-English locale's pack is merged in when it arrives.
   *
   * Held as state rather than a module-level cache on purpose. A module global
   * is what leaked one user's language into another's response before this
   * rewrite (see core.ts), and on Fluid Compute the same instance serves
   * concurrent requests. Webpack already caches the CHUNK, so a second
   * component mounting the same locale costs nothing extra.
   */
  const [packs, setPacks] = useState<Catalog>(STATIC_CATALOG);
  /**
   * The locale whose pack we tried to load and could not. Recorded so `ready`
   * can still become true for that user — otherwise a failed chunk request
   * would read as "translation is still loading" for the rest of the session.
   */
  const [packFailed, setPackFailed] = useState<string | null>(null);

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
        if (!cancelled) setConfigRead(true);
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

  /**
   * The locale whose STRINGS are in force. Not the same as `locale`: strings
   * follow the feature flag, formatting follows the tenant unconditionally.
   */
  const wanted = translationEnabled ? locale : DEFAULT_LOCALE;

  /**
   * Whether `wanted`'s strings are available — in hand, or known unobtainable.
   * Derived, not state: see the note on the loading effect below for the race
   * that the state version had.
   */
  const packAvailable = Boolean(packs[wanted]) || packFailed === wanted;

  /**
   * Fetch the resolved locale's pack, if it is not one of the static ones.
   *
   * Only reached when the flag is ON and the locale is not `en`, so an English
   * user — the common case — issues no request and downloads no chunk.
   *
   * Timing: this rides the /tenant-config await that already existed. Before
   * this change a fr-CA tenant saw English on first paint and French after the
   * config resolved; now the swap happens after the config AND the chunk. It
   * is one extra round trip on a language nobody has selected yet, against
   * 43 kB that every user was downloading on every page.
   *
   * Every failure is English. A rejected chunk request (offline, a CDN blip, a
   * deploy that rotated hashes mid-session) and a tenant row holding a tag this
   * build no longer serves both land here, and neither may take the page down:
   * `packs` keeps its static `en` and createTranslator's lookup chain drops the
   * absent locale, so the user reads English rather than dotted keys.
   *
   * Readiness is DERIVED above rather than tracked by this effect. It was a
   * `packSettled` state flag first, and that had a race the existing hook test
   * caught: `configRead` and `translationEnabled` are set in one batch, so the
   * render that turned the flag on committed with readiness still true from the
   * previous locale, and a consumer waiting on `ready` saw English. A value
   * computed during render cannot lag the state it depends on.
   */
  useEffect(() => {
    // Already static (en), or already merged in from an earlier render.
    if (packs[wanted]) return;
    let cancelled = false;
    // Tracked locally rather than read back off `packs` in the `finally`: that
    // closure captures the `packs` of THIS render, which by definition does not
    // contain the pack we are about to add, so it recorded every success as a
    // failure. Readiness happened not to care, which is what would have kept it
    // hidden — and it would have made packFailed useless as a signal.
    let arrived = false;
    loadLocalePack(wanted)
      .then((pack) => {
        if (cancelled || !pack) return;
        arrived = true;
        // Return the SAME object when the locale is already present, so this
        // cannot re-trigger the memo below and loop.
        setPacks((prev) => (prev[wanted] ? prev : { ...prev, [wanted]: pack }));
      })
      .catch(() => {
        // Deliberately silent to the user: the page reads English, which is
        // a degradation rather than a fault worth interrupting anyone over.
      })
      .finally(() => {
        // A null pack — a tag this build cannot serve — counts as failed too:
        // it will never arrive, so readiness must not wait for it.
        if (!cancelled && !arrived) setPackFailed(wanted);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, packs]);

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
    // `packs`, not the static catalog: this is what makes a lazily-loaded
    // locale take effect once it lands. Until then the chain falls through to
    // `en`, which is why an in-flight pack shows English and not raw keys.
    const { t } = createTranslator(wanted, packs);
    return {
      locale,
      currency,
      // Both halves. See ShellI18n.ready.
      ready: configRead && packAvailable,
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
  }, [locale, currency, configRead, packAvailable, translationEnabled, wanted, packs]);
}
