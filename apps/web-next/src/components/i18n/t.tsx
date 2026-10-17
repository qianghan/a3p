'use client';

import type { JSX } from 'react';
import { useT } from '@/hooks/use-t';
import type { TFn } from '@/hooks/use-t';

/**
 * Translated text for React Server Components.
 *
 * Server components cannot call hooks, so they cannot call useT() directly.
 * This tiny client boundary renders one translated string, letting server
 * pages stay server-rendered while their copy lives in the i18n catalog.
 * Falls back to humanised English when no provider is present (same as useT).
 */
export function T({
  k,
  params,
}: {
  k: string;
  params?: Parameters<TFn>[1];
}): JSX.Element {
  const t = useT();
  return <>{t(k, params)}</>;
}
