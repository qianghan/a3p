import type { DocFilter } from '@/lib/mobile/types';
import { readJson, writeJson } from './safe-storage';

export const DOC_FILTERS: readonly DocFilter[] = ['needs-review', 'no-category', 'no-receipt', 'all', 'archived'];
const NAV_KEY = 'ab:mobile:docs:nav';

export interface DocNav { ids: string[]; filter: DocFilter; q: string }

export function parseDocFilter(raw: string | null | undefined): DocFilter {
  return (DOC_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as DocFilter) : 'all';
}

/** The ids the list showed, in order — so the viewer's prev/next walks the SAME filtered list. */
export function saveDocNav(nav: DocNav): void {
  writeJson('session', NAV_KEY, nav);
}

export function readDocNav(): DocNav | null {
  const v = readJson<DocNav | null>('session', NAV_KEY, null);
  return v && Array.isArray(v.ids) ? { ids: v.ids.filter((x) => typeof x === 'string'), filter: parseDocFilter(v.filter), q: typeof v.q === 'string' ? v.q : '' } : null;
}

export function neighbors(nav: DocNav | null, id: string): { prev: string | null; next: string | null } {
  if (!nav) return { prev: null, next: null };
  const i = nav.ids.indexOf(id);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? nav.ids[i - 1] : null, next: i < nav.ids.length - 1 ? nav.ids[i + 1] : null };
}

export function removeFromDocNav(id: string): void {
  const nav = readDocNav();
  if (nav) saveDocNav({ ...nav, ids: nav.ids.filter((x) => x !== id) });
}

export function docsHref(nav: DocNav | null): string {
  const p = new URLSearchParams();
  if (nav && nav.filter !== 'all') p.set('filter', nav.filter);
  if (nav?.q) p.set('q', nav.q);
  const s = p.toString();
  return s ? `/app/docs?${s}` : '/app/docs';
}
