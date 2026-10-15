'use client';

import { useContext } from 'react';
import { ShellContextReact } from '@/contexts/shell-context';

/**
 * Money in the TENANT currency via the shell's formatMoney. Without a provider,
 * a bare 2-decimal number, never a guessed currency symbol.
 */
export function useTenantMoney(): (cents: number) => string {
  const fmt = useContext(ShellContextReact)?.i18n?.formatMoney;
  return (cents: number) => (fmt ? fmt(cents) : (cents / 100).toFixed(2));
}
