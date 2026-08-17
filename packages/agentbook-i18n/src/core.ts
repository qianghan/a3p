/**
 * i18n runtime for AgentBook.
 *
 * Every user-facing string resolves through a Translator. No hardcoded
 * strings in business logic or UI.
 *
 * WHY THERE IS NO setLocale()
 * ---------------------------
 * This module previously held `currentLocale` in module scope and mutated it
 * through setLocale(). On Fluid Compute, function instances are reused across
 * *concurrent* requests, so that global leaked: a French user's request could
 * be served English because an English request had overwritten the shared
 * variable while the first was awaiting a DB call. `concurrency.test.ts`
 * demonstrates the failure.
 *
 * The fix is structural, not defensive: locale binds at construction, so
 * there is no shared mutable state to leak. Call sites stay terse because the
 * bound translator carries the locale for them.
 *
 *   const { t } = createTranslator(locale, CATALOG);
 *   t('expense.saved', { amount: '$45.00' });
 *
 * PLURALS
 * -------
 * When `params.count` is present, t() selects a plural variant via
 * Intl.PluralRules: `key_one`, `key_other`, etc. This is not optional
 * polish — French treats 0 as singular and has different rules from English,
 * so a count-bearing string without variants is wrong in French from day one.
 * zh-CN has a single form and the same mechanism covers it with no special
 * casing.
 */

/** A namespace tree of translations: flat strings or one level of nesting. */
export type TranslationData = Record<string, unknown>;

/** All locales, keyed by locale tag: { 'en': {...}, 'fr-CA': {...} }. */
export type Catalog = Record<string, TranslationData>;

export interface Translator {
  /** The locale this translator is bound to. Immutable. */
  readonly locale: string;
  /**
   * Resolve a key, with `{var}` interpolation and count-based plural
   * selection. Falls back through the locale's base language, then the
   * fallback locale, then returns the key itself so a miss is visible
   * rather than silent.
   */
  t(key: string, params?: Record<string, string | number>): string;
}

export const DEFAULT_LOCALE = 'en';

/**
 * Build a translator bound to one locale. Pure — no module state is read or
 * written, so concurrent callers cannot interfere with each other.
 */
export function createTranslator(
  locale: string,
  catalog: Catalog,
  fallbackLocale: string = DEFAULT_LOCALE,
): Translator {
  // Resolve the lookup chain ONCE at construction rather than per call.
  // e.g. 'fr-CA' → ['fr-CA', 'fr', 'en']; unknown 'de' → ['en'].
  const chain = buildLookupChain(locale, catalog, fallbackLocale);

  function t(key: string, params?: Record<string, string | number>): string {
    const template = resolveTemplate(key, chain, catalog, params?.count);
    if (template === undefined) return key;
    if (!params) return template;
    return interpolate(template, params);
  }

  return { locale, t };
}

/**
 * Ordered list of catalog keys to try for a given locale.
 * Exact tag first, then the bare language, then the fallback. Deduplicated,
 * and entries absent from the catalog are dropped so lookups stay cheap.
 */
function buildLookupChain(locale: string, catalog: Catalog, fallbackLocale: string): string[] {
  const candidates = [locale, locale.split('-')[0], fallbackLocale];
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (catalog[c]) chain.push(c);
  }
  // If nothing matched at all, still try the fallback so a miss returns the
  // English string rather than the raw key where possible.
  if (chain.length === 0 && catalog[fallbackLocale]) chain.push(fallbackLocale);
  return chain;
}

/**
 * Find a template for `key` across the lookup chain. When `count` is defined,
 * prefer the plural variant for the first locale in the chain that has one.
 */
function resolveTemplate(
  key: string,
  chain: string[],
  catalog: Catalog,
  count: string | number | undefined,
): string | undefined {
  for (const loc of chain) {
    const data = catalog[loc];
    if (!data) continue;

    if (count !== undefined) {
      const n = typeof count === 'number' ? count : Number(count);
      if (Number.isFinite(n)) {
        const category = pluralCategory(loc, n);
        const variant =
          readKey(data, `${key}_${category}`) ?? readKey(data, `${key}_other`);
        if (variant !== undefined) return variant;
      }
    }

    const exact = readKey(data, key);
    if (exact !== undefined) return exact;
  }
  return undefined;
}

/**
 * Intl.PluralRules category for a locale/count. Falls back to a crude
 * English-like rule if the runtime rejects the tag, so an unusual locale
 * degrades to readable output instead of throwing mid-render.
 */
function pluralCategory(locale: string, n: number): string {
  try {
    return new Intl.PluralRules(locale).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/** Read a dot-notated key ('expense.receipt_saved') from a namespace tree. */
function readKey(data: TranslationData, key: string): string | undefined {
  let current: unknown = data;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in (current as object)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * Replace `{name}` with params.name. A missing param renders as the literal
 * `{name}` on purpose — a visible placeholder is easier to catch in review
 * than a silently empty string.
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (literal, name: string) => {
    const v = params[name];
    return v === undefined ? literal : String(v);
  });
}

/**
 * Pick a locale from the available signals, in priority order:
 *   tenant config > Accept-Language > Telegram language_code > fallback
 *
 * Pure: takes the catalog's available locales rather than consulting module
 * state, so it is safe to call per request.
 *
 * Accept-Language is parsed with q-weights (RFC 7231) and sorted by weight.
 * An unrecognised value never throws — it falls through to the next signal
 * and ultimately to `fallbackLocale`. That matters because every existing
 * AbTenantConfig row stores 'en-US', which must resolve rather than reject.
 */
export function resolveLocale(
  sources: {
    tenantLocale?: string | null;
    acceptLanguage?: string | null;
    telegramLanguageCode?: string | null;
  },
  available: string[],
  fallbackLocale: string = DEFAULT_LOCALE,
): string {
  const match = (tag: string | null | undefined): string | undefined => {
    if (!tag) return undefined;
    const lower = tag.toLowerCase();
    // Exact tag match, case-insensitive ('zh-cn' → 'zh-CN').
    const exact = available.find((a) => a.toLowerCase() === lower);
    if (exact) return exact;
    // Language-prefix match ('fr' → 'fr-CA', 'en-US' → 'en').
    const base = lower.split('-')[0];
    return available.find((a) => a.toLowerCase().split('-')[0] === base);
  };

  const fromTenant = match(sources.tenantLocale);
  if (fromTenant) return fromTenant;

  if (sources.acceptLanguage) {
    for (const tag of parseAcceptLanguage(sources.acceptLanguage)) {
      const hit = match(tag);
      if (hit) return hit;
    }
  }

  const fromTelegram = match(sources.telegramLanguageCode);
  if (fromTelegram) return fromTelegram;

  return fallbackLocale;
}

/** Language tags from an Accept-Language header, highest q-weight first. */
function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';').map((s) => s.trim());
      let q = 1;
      for (const p of params) {
        const m = p.match(/^q=([0-9.]+)$/);
        if (m) {
          const parsed = Number(m[1]);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { tag, q };
    })
    .filter((c) => c.tag && c.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((c) => c.tag);
}
