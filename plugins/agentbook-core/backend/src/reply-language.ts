/**
 * Which language a reply should be in.
 *
 * The LLM half of a reply already mirrors the user (see language.ts). The
 * deterministic half — catalog templates and number/date formatting — read
 * AbTenantConfig.locale instead, so an English question on a fr-CA tenant got
 * an English summary with `42 014,79 CA$` inside it and a French result line
 * after it. One resolver, used by both halves, ends that.
 *
 * Rule: language of THIS message → language of the most recent earlier user
 * message that is detectable → tenant locale → en-US. English keeps the
 * tenant's region (en-CA on a Canadian tenant) so currency formats the way
 * that country writes it.
 */
export type DetectedLanguage = 'en' | 'fr' | 'zh';

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const FR_MARK = /[àâçéèêëîïôûùüÿœ]/i;
const FR_WORDS = /\b(le|la|les|des|du|de|un|une|mes|mon|ma|je|tu|nous|vous|est|sont|pour|avec|sur|dans|que|qui|pas|combien|montre|moi|oui|non|dépens\w*|facture\w*|catégori\w*)\b/i;
const EN_WORDS = /\b(the|my|me|i|is|are|was|show|what|how|much|did|spend|spent|expenses?|invoices?|categori[sz]e|them|this|last|month|year|please|can|you|give|more|details?|cash|balance|what's|whats)\b/i;

export function detectMessageLanguage(text: string): DetectedLanguage | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  if (CJK.test(s)) return 'zh';
  const words = s.split(/\s+/).filter((w) => /[a-zà-ÿ]/i.test(w));
  if (words.length < 2 && !FR_MARK.test(s)) {
    // One-word turns ("yes", "ok", "oui") are continuation, not a signal.
    return null;
  }
  const fr = (FR_MARK.test(s) ? 1 : 0) + (s.match(new RegExp(FR_WORDS.source, 'gi'))?.length ?? 0);
  const en = s.match(new RegExp(EN_WORDS.source, 'gi'))?.length ?? 0;
  if (fr === 0 && en === 0) return null;
  return fr > en ? 'fr' : 'en';
}

const ENGLISH_REGIONS = new Set(['CA', 'AU', 'GB', 'US', 'NZ', 'IE']);

function regionOf(locale: string | null | undefined): string | null {
  const m = (locale ?? '').match(/^[a-z]{2,3}[-_]([A-Za-z]{2})\b/);
  return m ? m[1].toUpperCase() : null;
}

function localeFor(lang: DetectedLanguage, tenantLocale: string | null | undefined): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'fr') return 'fr-CA';
  const region = regionOf(tenantLocale);
  return region && ENGLISH_REGIONS.has(region) ? `en-${region}` : 'en-US';
}

export function resolveReplyLocale(opts: {
  text: string;
  /** Earlier USER messages, most recent first. */
  previousUserTexts?: string[];
  tenantLocale?: string | null;
}): string {
  const tenant = opts.tenantLocale && opts.tenantLocale.trim() ? opts.tenantLocale.trim() : null;
  let lang = detectMessageLanguage(opts.text);
  if (!lang) {
    for (const prev of opts.previousUserTexts ?? []) {
      lang = detectMessageLanguage(prev);
      if (lang) break;
    }
  }
  if (!lang) return tenant ?? 'en-US';
  const tenantLang = tenant?.toLowerCase().split(/[-_]/)[0];
  if (tenantLang === lang) return tenant!;
  return localeFor(lang, tenant);
}
