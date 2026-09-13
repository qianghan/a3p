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
 * message that is detectable → language of the most recent earlier assistant
 * reply that is detectable → tenant locale → en-US. English keeps the
 * tenant's region (en-CA on a Canadian tenant) so currency formats the way
 * that country writes it.
 *
 * The assistant fallback exists because a run of bare user turns ("cancel",
 * "yes", "undo") carries no language signal at all, so before it existed the
 * resolver fell straight through to the tenant locale mid-thread — an
 * English user on a fr-CA tenant would suddenly get a French reply. The
 * assistant's own last reply is written in whatever language this same
 * resolver already picked, so it is a reliable stand-in for "what language is
 * this conversation in" when the user side has nothing detectable.
 */
export type DetectedLanguage = 'en' | 'fr' | 'zh';

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
// Accents alone are a weak signal: é/è/ê/ë/î/ï/ô/û/ù/ç/œ all also occur in
// Spanish and/or Portuguese (é) or Italian/Portuguese (à, â, ü, ÿ - dropped
// from this set for that reason). Never let accents alone cross the fr>=2
// threshold below; they only corroborate a distinctive word.
const FR_MARK = /[éèêëîïôûùçœ]/i;
// DISTINCTIVE French tokens only - i.e. words that are NOT common Spanish,
// Portuguese, or Italian vocabulary too. Pan-Romance words that used to live
// here (la, de, un, une, mes, mon, ma, est, sont, sur, non, que) caused
// Spanish/Portuguese/Italian input to misdetect as French: "Registra un
// gasto de 42 euros" (Spanish) hit `un` + `de`; "que" is Spanish as well as
// French, so it was dropped too. `pas`, `au`/`aux`, `qui`, `tu`/`je`/`nous`/
// `vous` etc. have no everyday Spanish/Portuguese/Italian equivalent spelled
// the same way, so they stay.
const FR_WORDS =
  /\b(le|les|des|du|je|tu|nous|vous|pour|avec|dans|qui|pas|combien|montre|moi|oui|dépens\w*|facture\w*|catégori\w*|déjeuner|au|aux)\b/gi;
// Everyday expense-chat vocabulary, so ordinary English is recognised without
// pronouns ("Lunch at Le Petit Bistro $34"). One flat alternation of literal
// words and single \w* tails - no nested quantifiers, so matching stays linear.
const EN_WORDS =
  /\b(the|my|me|i|is|are|was|show|what|how|much|did|spend|spent|expenses?|invoices?|categori[sz]ed?|them|this|last|month|year|please|can|you|give|more|details?|cash|balance|what's|whats|lunch|dinner|coffee|at|for|on|with|paid|bought|receipt|client|meeting|taxi|uber|flight|hotel|parking|gas|fuel|office|supplies|subscription|invoice|estimate|payment|total|add|record|log|note|thanks|ok(ay)?|today|yesterday|week|tax|deduct\w*)\b/gi;

export function detectMessageLanguage(text: string): DetectedLanguage | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  if (CJK.test(s)) return 'zh';
  const words = s.split(/\s+/).filter((w) => /[a-zà-ÿ]/i.test(w));
  if (words.length < 2 && !FR_MARK.test(s)) {
    // One-word turns ("yes", "ok", "oui") are continuation, not a signal.
    return null;
  }
  // FR_WORDS/EN_WORDS are module-level `g`-flagged regexes reused across
  // calls. String.prototype.match resets a global regex's lastIndex to 0
  // before it walks the string, so reusing the same object here is safe -
  // no per-call `new RegExp(...)` needed.
  const fr = (FR_MARK.test(s) ? 1 : 0) + (s.match(FR_WORDS)?.length ?? 0);
  const en = s.match(EN_WORDS)?.length ?? 0;
  // French needs corroboration. A vendor name is not a language: "Lunch at Le
  // Petit Bistro $34" scores fr=1 on `le` alone, and on the old `fr > en` rule
  // one proper noun switched an English user's entire reply - templates and
  // money formatting included - into French. Two independent French signals
  // are required (the accent mark counts as one, each stopword hit as one);
  // since the accent contributes at most 1, `fr >= 2` already guarantees at
  // least one distinctive French word matched, not just an accented
  // pan-Romance word. A lone unbacked signal falls through to the thread,
  // then the tenant - and a language this detector doesn't know (Spanish,
  // Portuguese, Italian, ...) never scores fr>=2 on borrowed accents alone.
  if (fr >= 2 && fr > en) return 'fr';
  if (en >= 1) return 'en';
  return null;
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

// Known limitation: adapter-native Telegram replies that never reach the
// brain (expense-draft confirm/cancel, review-queue walk-through) resolve
// language from the incoming text only - they have no previousUserTexts to
// fall back through. A bare typed "yes" there is a one-word continuation
// (see the words.length < 2 guard above), so it resolves straight to the
// tenant locale rather than continuing whatever language the thread was in.
export function resolveReplyLocale(opts: {
  text: string;
  /** Earlier USER messages, most recent first. */
  previousUserTexts?: string[];
  /** Earlier ASSISTANT replies, most recent first. Consulted only after
   *  `previousUserTexts` is exhausted with nothing detectable. */
  previousAssistantTexts?: string[];
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
  if (!lang) {
    for (const prev of opts.previousAssistantTexts ?? []) {
      lang = detectMessageLanguage(prev);
      if (lang) break;
    }
  }
  if (!lang) return tenant ?? 'en-US';
  const tenantLang = tenant?.toLowerCase().split(/[-_]/)[0];
  if (tenantLang === lang) return tenant!;
  return localeFor(lang, tenant);
}
