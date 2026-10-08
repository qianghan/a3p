import type { TFn } from '@/hooks/use-t';

const KEY_SHAPE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i;
const PLACEHOLDER = /\{\w+\}/;

/** What useT's provider-less fallback would show for a key: its last segment, humanised. */
function humanised(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  return leaf.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Resolve an i18n key that the SERVER chose (UpcomingItem.titleKey for a
 * calendar event a jurisdiction pack seeded), or null when it does not resolve.
 *
 * WHY THIS TAKES `translate` AND NOT t
 *
 * These keys are data, not UI copy. The pack that seeds them is open-ended and
 * several are spelled differently from the catalog (CA seeds `instalment`, the
 * catalog has `installment`), so no static scan can prove they resolve — the
 * hygiene guard's "every t() names a literal" rule cannot apply, and a
 * suppression would only hide that. The safety lives here instead: a result is
 * accepted ONLY if it is a real translation. The translator returns the key
 * itself on a miss, useT's provider-less fallback returns the humanised leaf,
 * and a template whose params the server did not send still holds `{name}` —
 * all three are "unresolved", and the caller substitutes a catalog-backed
 * neutral label. A raw key, a humanised key or a literal placeholder is never
 * returned.
 */
export function resolveServerKey(translate: TFn, key: string, params: Record<string, string | number> = {}): string | null {
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return null;
  const out = translate(key, params);
  if (typeof out !== 'string' || out === '' || out === key || out === humanised(key) || PLACEHOLDER.test(out)) return null;
  return out;
}
