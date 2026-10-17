'use client';

import { useContext, type JSX } from 'react';
import { ShellContextReact } from '@/contexts/shell-context';
import { formatCurrency as formatCurrencyWithLocale } from '@agentbook/i18n';

/**
 * Locale-aware money rendering for React Server Components.
 *
 * Server components cannot call hooks, so they cannot reach the shell's
 * locale-bound formatCurrency(). The bare formatMoney(cents, currency)
 * helper infers a display locale from the currency code — wrong for a
 * fr-CA reader seeing CAD (they should read "1 234,56 $", not "$1,234.56").
 * This tiny client boundary formats with the resolved user locale instead.
 * Falls back to currency-inferred formatting when no provider is present.
 */
export function Money({
  cents,
  currency,
  className,
  style,
}: {
  cents: number;
  currency: string;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  const ctx = useContext(ShellContextReact);
  const format = ctx?.i18n?.formatCurrency;
  const text = format
    ? format(cents, currency)
    : formatCurrencyWithLocale(cents, 'en', currency);
  return (
    <span className={className} style={style}>
      {text}
    </span>
  );
}
