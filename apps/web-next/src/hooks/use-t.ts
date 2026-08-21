'use client';

import { useContext } from 'react';
import { ShellContextReact } from '@/contexts/shell-context';
/** The `t` function's shape, taken from Translator.t in @agentbook/i18n. */
export type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * The translator, for the SHELL's own components.
 *
 * WHY THIS EXISTS RATHER THAN CALLING useShellI18n() DIRECTLY
 *
 * useShellI18n() owns state: it fetches /tenant-config, holds the resolved
 * locale and the feature flag, and is meant to be called ONCE, by
 * ShellProvider. Calling it from each component would issue one config request
 * per component and give each its own independent notion of the locale — the
 * sidebar could finish loading as fr-CA while the page beside it was still
 * English. This reads the single instance the provider already put on the
 * context.
 *
 * WHY IT DOES NOT USE useShell()
 *
 * useShell() THROWS without a provider, and that has already broken a real
 * surface: the PWA shell at app/app renders outside ShellProvider, so a
 * component reaching for useShell() there crashes the whole route. A missing
 * translator must degrade to English, never take the page down — the same
 * decision the plugin SDK's useI18n() makes.
 *
 * WHAT THE FALLBACK RETURNS
 *
 * The key's last segment, humanised: `nav.expenses` -> "Expenses". That is
 * deliberately close to correct English so a provider-less render is readable
 * rather than showing a raw dotted key to the user — but it is a safety net,
 * not a translation source. If a whole surface looks subtly wrong (lowercase
 * brand names, odd capitalisation), suspect that it is rendering outside the
 * provider rather than that the catalog is wrong.
 */
export function useT(): TFn {
  const ctx = useContext(ShellContextReact);
  const t = ctx?.i18n?.t;
  if (t) return t;

  return (key: string, params?: Record<string, string | number>): string => {
    const leaf = key.split('.').pop() ?? key;
    const humanised = leaf.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    if (!params) return humanised;
    return Object.entries(params).reduce(
      (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      humanised,
    );
  };
}

/** The resolved locale, for formatting call sites in shell components. */
export function useShellLocale(): string {
  return useContext(ShellContextReact)?.i18n?.locale ?? 'en';
}
