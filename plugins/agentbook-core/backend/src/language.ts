/**
 * What language to answer in.
 *
 * There used to be exactly one rule in the entire chat path:
 *
 *     ...(isFrenchLocale(tenantConfig?.locale) ? ['Respond in French.'] : [])
 *
 * so every language that is not French fell through to English. A user asked
 * "给我介绍一下今年报税的新规定" and was answered in Chinese by luck — the model's
 * own default — then the next turn came back in English and the thread was
 * broken in the middle. Half-working is worse than never trying: it reads as
 * the product losing interest.
 *
 * The rule is: mirror the user, and keep mirroring. A model does this well
 * when told to; the failure was never capability, it was that nobody asked.
 *
 * Short affirmatives are the case that needs spelling out. "是的", "oui", "ok"
 * carry little signal on their own, and a model asked to detect the language
 * of two characters will often guess English and switch. Anchoring to the
 * conversation, then to the tenant's configured locale, keeps a thread stable.
 */

export interface LocaleSource {
  /** BCP-47 from AbTenantConfig, e.g. 'en-US', 'fr-CA', 'zh-CN'. */
  locale?: string | null;
}

/** Human-readable name for the prompt. Falls back to the raw tag. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  zh: 'Chinese',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  ar: 'Arabic',
  vi: 'Vietnamese',
  th: 'Thai',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
};

export function localeLanguageName(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string' || !locale.trim()) return null;
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[primary] ?? null;
}

/**
 * The instruction to append to any chat-facing system prompt.
 *
 * Deliberately one block used by every prompt site rather than a line copied
 * into each. There were already two near-identical accountant-fallback prompts
 * in different packages, only one of which carried the French rule — which is
 * precisely how a language fix reaches half the surfaces.
 */
export function languageDirective(config: LocaleSource | null | undefined): string {
  const preferred = localeLanguageName(config?.locale);
  return [
    'LANGUAGE: Reply in the same language the user wrote their message in.',
    'If their message is too short to tell (for example "yes", "ok", "是的", "oui"),',
    'continue in the language the conversation has been using so far' +
      (preferred ? `, and otherwise use ${preferred}.` : '.'),
    'Never switch language mid-conversation unless the user does.',
  ].join(' ');
}
