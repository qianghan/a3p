import type { TFn } from '@/hooks/use-t';

const KEY_SHAPE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i;

/** What useT's provider-less fallback would show for a key: its last segment, humanised. */
function humanised(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  return leaf.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Resolve an i18n key that the SERVER chose (UpcomingItem.titleKey for a
 * calendar event a jurisdiction pack seeded), or null when it does not resolve.
 *
 * These keys are data, not UI copy: the pack that seeds them is open-ended and
 * some are spelled differently from the catalog (CA seeds `instalment`, the
 * catalog has `installment`), so no static scan can prove they resolve. The
 * lookup is therefore marked i18n-dynamic, and the safety lives here: a result
 * is accepted ONLY if it is a real translation. The translator returns the key
 * itself on a miss, useT's provider-less fallback returns the humanised leaf,
 * and a template whose params the server did not send still needs `{name}` —
 * all "unresolved", and the caller substitutes a catalog-backed neutral label.
 *
 * Placeholders are judged on the TEMPLATE, never on the final string: a vendor
 * called "Acme {CA}" is user data and must not make the title look unresolved.
 */
export function resolveServerKey(t: TFn, key: string, params: Record<string, string | number> = {}): string | null {
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return null;
  // `count` selects the plural variant of the template; every other placeholder stays visible in it.
  const countOnly = params.count === undefined ? undefined : { count: params.count };
  // i18n-dynamic: server-chosen UpcomingItem.titleKey (open calendar.* set seeded by jurisdiction packs); validated below — raw/humanised/unfilled falls back to mobile.home.next_up.fallback_*
  const [template, out] = [t(key, countOnly), t(key, params)];
  if (typeof template !== 'string' || template === '' || template === key || template === humanised(key)) return null;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in params)) return null;
  }
  return typeof out === 'string' && out !== '' ? out : null;
}
