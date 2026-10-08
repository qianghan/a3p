'use client';

import { useMemo } from 'react';
import { formatDate, formatDateOnly } from '@agentbook/i18n';
import { useShellLocale } from '@/hooks/use-t';

export interface Formatters {
  /** An instant's wall-clock time, e.g. "3:04 PM" — used for "as of HH:MM". */
  time(iso: string): string;
  /** An instant's local calendar day, e.g. "Oct 7". */
  date(iso: string): string;
  /** A LOGICAL date ("2026-10-15") — never shifted by the viewer's zone. */
  dateOnly(iso: string): string;
}

export function makeFormatters(locale: string): Formatters {
  return {
    time: (iso) => formatDate(iso, locale, { hour: 'numeric', minute: '2-digit' }),
    date: (iso) => formatDate(iso, locale, { month: 'short', day: 'numeric' }),
    dateOnly: (iso) => formatDateOnly(iso.slice(0, 10), locale, { month: 'short', day: 'numeric' }),
  };
}

export function useFormatters(): Formatters {
  const locale = useShellLocale();
  return useMemo(() => makeFormatters(locale), [locale]);
}
