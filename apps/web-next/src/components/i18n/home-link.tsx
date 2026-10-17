'use client';

import Link from 'next/link';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useT } from '@/hooks/use-t';

/**
 * Site home link with a translated accessible name.
 *
 * Server pages cannot call useT(), so the aria-label — counted by the i18n
 * ratchet as user-facing copy — lives behind this tiny client boundary
 * instead of being hardcoded in each page header.
 */
export function HomeLink({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const t = useT();
  return (
    <Link href="/" aria-label={t('common.demo_aria_home')} className={className} style={style}>
      {children}
    </Link>
  );
}
