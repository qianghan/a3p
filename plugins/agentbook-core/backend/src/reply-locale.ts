/**
 * The translator for the agent's own deterministic replies.
 *
 * Three layers of the chat surface follow the user's language already:
 * the Telegram adapter's chrome (310 keys, via runWithBotLocale), the LLM's
 * prose (via languageDirective, which tells the model to mirror the user), and
 * the web shell. The deterministic replies this module serves — "Undone: X",
 * the low-confidence lead-in, the session prompts — were the layer left in
 * English, which is what produced French prose wrapped in English chrome.
 *
 * WHY IT LIVES HERE AND NOT IN apps/web-next
 * agentbook-core must not depend on apps/web-next: this module is imported by
 * the production Next routes AND by `tsx src/server.ts` in development. The
 * bot's equivalent, agentbook-bot-locale.ts, is `server-only` and therefore
 * unusable from here. `@agentbook/i18n` is a workspace package, which is the
 * same route `@agentbook/jurisdictions` already takes.
 *
 * WHY IT TAKES THE CONFIG RATHER THAN READING IT
 * Every caller already holds `tenantConfig` — it is threaded through for
 * `languageDirective` and for currency. Reading the row again here would add a
 * query per message and let the two disagree.
 */

import { createTranslator, resolveLocale, type Translator } from '@agentbook/i18n';
import { CATALOG, AVAILABLE_LOCALES } from '@agentbook/i18n/catalog';

export interface ReplyLocaleSource {
  /** BCP-47 from AbTenantConfig, e.g. 'en-US', 'fr-CA', 'zh-CN'. */
  locale?: string | null;
}

/**
 * Translators are immutable and building one parses the catalog, so they are
 * cached per locale rather than per message. There are three locales and
 * potentially thousands of messages.
 */
const cache = new Map<string, Translator['t']>();

function translatorFor(locale: string): Translator['t'] {
  let t = cache.get(locale);
  if (!t) {
    t = createTranslator(locale, CATALOG).t;
    cache.set(locale, t);
  }
  return t;
}

/**
 * The reply translator for a tenant.
 *
 * An absent or unrecognised locale resolves to English rather than throwing,
 * because a missing config row must never cost the user their answer.
 */
export function replyT(config: ReplyLocaleSource | null | undefined): Translator['t'] {
  const locale = resolveLocale(
    { tenantLocale: config?.locale ?? undefined },
    AVAILABLE_LOCALES,
  );
  return translatorFor(locale);
}

/** Test seam: the cache is process-wide and would otherwise leak between cases. */
export function __clearReplyLocaleCache(): void {
  cache.clear();
}
