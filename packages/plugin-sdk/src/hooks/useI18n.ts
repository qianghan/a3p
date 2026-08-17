/**
 * useI18n — localisation for plugin components.
 *
 * The shell resolves the locale once and injects a bound translator on
 * ShellContext. Plugins consume it here.
 *
 *   const { t, locale, formatMoney } = useI18n();
 *   return <h1>{t('expense.title')}</h1>;
 *
 * WHY THIS HOOK EXISTS RATHER THAN `useShell().i18n!`
 *
 * Plugin bundles are served from a CDN and versioned independently of the
 * shell, so a plugin can be running against an OLDER shell that does not
 * inject `i18n` at all. `useShell().i18n!.t(...)` would throw and take the
 * whole page down over a missing translation layer.
 *
 * This hook returns a working English fallback in that case: keys resolve to
 * the last segment humanised, and the formatters fall back to Intl with
 * 'en-US'. A plugin therefore renders readable English on an old shell instead
 * of crashing — degraded, not broken.
 *
 * The fallback is intentionally NOT a full catalog. Shipping one would mean two
 * sources of truth for every string, and the copies would drift.
 */

import { useMemo } from 'react';
import { useShell } from './useShell.js';
import type { II18nService } from '../types/services.js';

/** Currency -> display locale, mirroring @agentbook/i18n's own table. */
const FALLBACK_CURRENCY_LOCALES: Record<string, string> = {
  USD: 'en-US',
  CAD: 'en-CA',
  AUD: 'en-AU',
  EUR: 'de-DE',
};

/**
 * Turn a translation key into readable English.
 * 'expense.receipt_saved' -> 'Receipt saved'
 *
 * Better than showing the raw key: a user on an outdated shell sees words, not
 * `expense.receipt_saved`. It will not match the real copy exactly, which is
 * why the architecture invariants assert no raw key reaches the DOM in the
 * normal (injected) path.
 */
function humanizeKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (literal, name: string) => {
    const v = params[name];
    return v === undefined ? literal : String(v);
  });
}

/** English-only service used when the shell injects no i18n. */
function createFallbackI18n(): II18nService {
  const locale = 'en-US';
  return {
    locale: 'en',
    t: (key, params) => interpolate(humanizeKey(key), params),
    formatMoney: (cents, currency = 'USD') => {
      const loc = FALLBACK_CURRENCY_LOCALES[currency] ?? 'en-US';
      try {
        return new Intl.NumberFormat(loc, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(cents / 100);
      } catch {
        return `${currency} ${(cents / 100).toFixed(2)}`;
      }
    },
    formatCurrency: (cents, currency = 'USD') => {
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(cents / 100);
      } catch {
        return `${currency} ${(cents / 100).toFixed(2)}`;
      }
    },
    formatDate: (date, options) => {
      const d = typeof date === 'string' ? new Date(date) : date;
      try {
        return new Intl.DateTimeFormat(
          locale,
          options ?? { year: 'numeric', month: 'short', day: 'numeric' },
        ).format(d);
      } catch {
        return String(date);
      }
    },
    formatNumber: (value, options) => {
      try {
        return new Intl.NumberFormat(locale, options).format(value);
      } catch {
        return String(value);
      }
    },
    parseAmount: (raw: string) => {
      // en-US conventions only, matching the rest of this fallback.
      const cleaned = String(raw ?? '').trim().replace(/[^0-9.,\-]/g, '');
      const noGroups = cleaned.replace(/,/g, '');
      const n = Number(noGroups);
      if (!Number.isFinite(n) || noGroups === '') {
        return { ok: false, cents: 0, ambiguous: false, formatted: '' };
      }
      const cents = Math.round(n * 100);
      return {
        ok: true,
        cents,
        ambiguous: false,
        formatted: new Intl.NumberFormat('en-US', {
          style: 'currency', currency: 'USD',
        }).format(cents / 100),
      };
    },
    formatPercent: (value, decimals = 1) => {
      try {
        return new Intl.NumberFormat(locale, {
          style: 'percent',
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);
      } catch {
        return `${(value * 100).toFixed(decimals)}%`;
      }
    },
  };
}

/**
 * Localisation service for the current plugin.
 *
 * Always returns a usable service. The version-skew case this protects against
 * is a ShellProvider that exists but carries no `i18n` — i.e. a CDN plugin
 * bundle running against an older shell. That degrades to English.
 *
 * Used entirely outside a ShellProvider it throws, exactly like every other
 * SDK hook (`useAuthService`, `usePermissions`, ...). That is a wiring mistake
 * in the plugin's own mount(), not version skew, and failing loudly in dev is
 * the right response.
 */
export function useI18n(): II18nService {
  const shell = useShell();
  const injected = shell.i18n;
  // Memoised on the injected service so the fallback isn't rebuilt per render.
  return useMemo(() => injected ?? createFallbackI18n(), [injected]);
}

/** Just the resolved locale tag. */
export function useLocale(): string {
  return useI18n().locale;
}

/** Exported for tests that assert the degrade path directly. */
export const __createFallbackI18n = createFallbackI18n;
