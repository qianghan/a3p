'use client';

import { usePathname } from 'next/navigation';
import { DOCS_UI } from './ui-strings';
import type { DocLocale } from './content';

/**
 * The docs locale, for client components.
 *
 * The server resolves it from the route params, but the header, sidebar and
 * search box live above `[...slug]` in the tree and never see them. They read
 * the URL instead — `/docs/zh/...` is the same signal, just observed from the
 * other side.
 *
 * Importing DocLocale as a TYPE keeps content.ts (and its `fs` import) out of
 * the client bundle.
 */
export function useDocsLocale(): { locale: DocLocale; ui: (typeof DOCS_UI)['en'] } {
  const pathname = usePathname() ?? '';
  const locale: DocLocale = /^\/docs\/zh(\/|$)/.test(pathname) ? 'zh' : 'en';
  return { locale, ui: DOCS_UI[locale] };
}
