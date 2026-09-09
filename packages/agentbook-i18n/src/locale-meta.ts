/**
 * Locale metadata, deliberately holding NO translation data.
 *
 * WHY THIS FILE EXISTS
 *
 * These values used to be derived from CATALOG — `AVAILABLE_LOCALES` was
 * `Object.keys(CATALOG)` — which read as the safer choice: two lists that
 * cannot drift apart because there is only one. The cost was invisible and
 * large. Importing anything derived from CATALOG retains ALL of CATALOG, so a
 * component that wanted nothing but the list of languages pulled in every
 * string in the product: a bundle whose only import was `offerableLocales`
 * measured 97 kB gzipped. The language switcher and the settings panel both
 * did exactly that.
 *
 * So the no-drift guarantee moves from DERIVED to ASSERTED: the lists are
 * declared here as plain data, and the architecture suite fails if they stop
 * matching the catalog. Same guarantee, none of the payload.
 *
 * ADDING A LOCALE  add the tag to LOCALE_TAGS and LOCALE_STATUS here, then
 * wire the packs in catalog.ts and catalog-client.ts. Miss any one of the
 * three and the architecture invariants say which.
 */

import { resolveLocale } from './core.js';
import { getOfferableLocales } from './selectable.js';

/** Locale tags this build can serve. Asserted to equal Object.keys(CATALOG). */
export const LOCALE_TAGS: string[] = ['en', 'fr-CA', 'zh-CN'];

/**
 * Translation readiness, per locale.
 *
 *   reference  the source of truth for keys ('en')
 *   ready      fully translated; content invariants apply
 *   scaffold   correct STRUCTURE, but values are still English placeholders
 *
 * Why this exists: a locale is built in two steps — structure first (so every
 * call site can be wired and type-checked), content second. Without an
 * explicit marker, the content invariants would either have to be omitted
 * (and then never added) or would block the structural work that has to land
 * first. Naming the state keeps both honest.
 *
 * A `scaffold` locale MUST NOT be user-selectable — the i18n feature flag is
 * what enforces that, and flipping it on while any locale is still `scaffold`
 * is a release error, asserted in the architecture suite.
 */
export type LocaleReadiness = 'reference' | 'ready' | 'scaffold';

export const LOCALE_STATUS: Record<string, LocaleReadiness> = Object.freeze({
  en: 'reference',
  'fr-CA': 'ready',
  'zh-CN': 'ready',
});

/**
 * Namespaces reached ONLY from the server, and therefore absent from the
 * client catalog. Each is verified to have zero client references by
 * apps/web-next/src/__tests__/architecture/i18n-client-catalog.test.ts, which
 * recomputes the reference set rather than trusting this list.
 *
 *   bot        Telegram reply copy — 76.6 kB raw across three locales, the
 *              single largest namespace, reached only by the webhook
 *   skill      agent skill descriptions, resolved in the brain
 *   proactive  scheduled nudge copy
 *   rate       rate-limit notices, emitted by the API
 *
 * Together 36 kB gzipped that no browser could ever render.
 */
export const SERVER_ONLY_NAMESPACES: string[] = ['bot', 'proactive', 'rate', 'skill'];

/**
 * Namespaces the client catalog ships. Declared rather than computed because
 * computing it would mean importing NAMESPACES, which is derived from CATALOG
 * — the very retention this file exists to avoid. The architecture suite
 * asserts CLIENT_NAMESPACES ∪ SERVER_ONLY_NAMESPACES === NAMESPACES, so a new
 * pack cannot go missing from both.
 */
export const CLIENT_NAMESPACES: string[] = [
  'accounting',
  'admin_ui',
  'agent',
  'agents',
  'billing',
  'billing_ui',
  'calendar',
  'chat',
  'common',
  'community_ui',
  'core_ui',
  'dash',
  'dashboard',
  'expense',
  'expenses_ui',
  'homeoffice',
  'invoice',
  'invoice_ui',
  'nav',
  'onboarding',
  'startup_ui',
  'student_ui',
  'tabs',
  'tax',
  'tax_ui',
];

/**
 * Locales offerable to a user right now — the selectable set filtered by
 * readiness, so a `scaffold` locale is never presented as a choice.
 *
 * Defined here rather than in either catalog entry point so there is ONE
 * implementation and it is reachable from a client component without dragging
 * a catalog along. Both '@agentbook/i18n/catalog' and
 * '@agentbook/i18n/catalog-client' re-export it.
 */
export function offerableLocales() {
  return getOfferableLocales(LOCALE_STATUS, (tenantLocale) =>
    resolveLocale({ tenantLocale }, LOCALE_TAGS),
  );
}
