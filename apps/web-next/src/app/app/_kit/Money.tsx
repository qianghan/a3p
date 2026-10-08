'use client';

import React from 'react';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { useShellLocale, useT } from '@/hooks/use-t';
import { tokens } from './tokens';

/** The one money formatter for /app: tenant currency, shell locale. */
export function moneyText(cents: number, currency: string, locale: string): string {
  return formatCurrencyCents(Math.round(cents), currency, locale);
}

export interface MoneyProps {
  cents: number | null;
  currency: string;
  size?: number;
  weight?: number;
  signed?: boolean;
}

/**
 * An amount. `null` means "this figure does not exist for you" (e.g. no tax
 * estimate for the jurisdiction) and renders a labelled dash — never "$0",
 * which would read as a real figure (spec §3.2 "truthful states").
 */
export function Money({ cents, currency, size, weight, signed = false }: MoneyProps) {
  const locale = useShellLocale();
  const t = useT();
  const style: React.CSSProperties = {
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    fontSize: size,
    fontWeight: weight,
  };
  if (cents === null || !Number.isFinite(cents)) {
    return (
      <span data-money="none" aria-label={t('mobile.kit.not_available')} style={{ ...style, color: tokens.color.muted }}>
        —
      </span>
    );
  }
  const text = moneyText(cents, currency, locale);
  return (
    <span data-money={currency} style={style}>
      {signed && cents > 0 ? `+${text}` : text}
    </span>
  );
}
