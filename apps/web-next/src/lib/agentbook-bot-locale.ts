import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createTranslator, type Translator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

import {
  OUTBOUND_FALLBACK,
  resolveOutboundLocale,
  type OutboundLocale,
} from './agentbook-outbound-format';

/**
 * The Telegram bot's per-update locale.
 *
 * WHY THE BOT NEEDS THIS AT ALL
 *
 * The webhook formatted every amount with a literal '$' prefix and every date
 * with a hardcoded 'en-US'. It reads `AbTenantConfig` in NINE separate places
 * and never once looked at `locale` — the answer was there, nine times over.
 *
 * So a Quebec user was told:
 *
 *     $1,234.56       where fr-CA reads    1 234,56 $
 *     Mar 22, 2026    where fr-CA reads    22 mars 2026
 *
 * and a GBP tenant was shown a DOLLAR SIGN on a pound amount, which is not a
 * formatting preference but a wrong figure. `fmtUsd` was called on 27 amounts
 * that were frequently not USD; the name was accurate about what it did and
 * wrong about what it was used for.
 *
 * WHY AsyncLocalStorage AND NOT A MODULE-LEVEL VARIABLE
 *
 * This is the part that matters. A `let currentLocale` at module scope would
 * be shared state on a reused instance: Fluid Compute deliberately serves
 * CONCURRENT requests from one function instance, so tenant B's update can
 * begin while tenant A's is still awaiting a database round trip. With a
 * module global, whoever wrote last wins, and tenant A finishes composing
 * their message using tenant B's currency.
 *
 * That failure is invisible in every test that sends one update at a time,
 * and it silently misstates money to the wrong person. AsyncLocalStorage
 * scopes the value to the async call tree instead, which is exactly the
 * lifetime a webhook update has. `botLocaleIsolation` in the tests drives two
 * interleaved updates specifically to hold this property down.
 *
 * WHY NOT THREAD IT THROUGH THE CALL SIGNATURES
 *
 * That is the more explicit design and normally the right one. Here it would
 * mean touching 58 functions across 6,500 lines to reach three formatters, in
 * a file whose failure mode is a silently broken bot. The blast radius of the
 * refactor is larger than the blast radius of the bug. The formatters are the
 * only consumers, so the implicit scope stays small and local.
 *
 * WHAT HAPPENS WITHOUT A SCOPE
 *
 * `botLoc()` returns OUTBOUND_FALLBACK (en-US / USD / America/New_York) —
 * exactly the behaviour that existed before this module, so an unwrapped code
 * path degrades to the old output rather than throwing inside a reply.
 */
interface BotScope {
  loc: OutboundLocale;
  t: Translator['t'];
}

const store = new AsyncLocalStorage<BotScope>();

/**
 * Translators are cached per locale rather than built per update.
 *
 * createTranslator resolves its lookup chain once at construction, so building
 * one costs real work; there are three locales and thousands of updates. The
 * cache is safe to share because a Translator is immutable — its locale is
 * readonly and t() holds no per-call state. That is the property that made a
 * shared LOCALE unsafe and makes a shared TRANSLATOR fine.
 */
const translators = new Map<string, Translator['t']>();

function translatorFor(locale: string): Translator['t'] {
  let t = translators.get(locale);
  if (!t) {
    t = createTranslator(locale, CATALOG).t;
    translators.set(locale, t);
  }
  return t;
}

/** The en-US translator, for any path that runs outside a scope. */
const FALLBACK_T = translatorFor(OUTBOUND_FALLBACK.locale);

/** Row shape read from AbTenantConfig — see resolveOutboundLocale. */
export interface TenantLocaleRow {
  locale?: string | null;
  currency?: string | null;
  timezone?: string | null;
}

/**
 * Run `fn` with the tenant's locale in scope. Everything awaited inside it,
 * however deep, sees the same value; a concurrent update sees its own.
 */
export function runWithBotLocale<T>(row: TenantLocaleRow | null | undefined, fn: () => T): T {
  const loc = resolveOutboundLocale(row);
  return store.run({ loc, t: translatorFor(loc.locale) }, fn);
}

/** The current update's locale, or the en-US fallback outside any scope. */
export function botLoc(): OutboundLocale {
  return store.getStore()?.loc ?? OUTBOUND_FALLBACK;
}

/**
 * The bot's translator, for the strings the ADAPTER composes.
 *
 * The dynamic half of a reply — the agent brain's prose — has been localised
 * for a while: agent-brain.ts appends languageDirective(tenantConfig) to every
 * chat prompt. So a French user already received French prose wrapped in
 * English chrome:
 *
 *     📒 Draft receipt — Café Olimpico pour 12,50 $ sous Repas.
 *        This isn't on the books yet. Tap ✅ to confirm...
 *
 * which reads worse than either language alone. These 304 keys are that
 * chrome.
 *
 * NOT translated, deliberately:
 *   - Gemini prompts ("Extract the receipt data."). They flow to a model, not
 *     a person; translating them degrades OCR silently.
 *   - buildTaxNote's guidance, English in every locale by product decision.
 *     Its AMOUNTS still follow the tenant, via fmtAmount.
 *   - slash commands. `/help expenses` is a literal the user types; only the
 *     description after the dash is translated.
 */
export function botT(key: string, params?: Record<string, string | number>): string {
  return (store.getStore()?.t ?? FALLBACK_T)(key, params);
}

/** Whether a scope is active. For tests and diagnostics, not for branching. */
export function hasBotLocale(): boolean {
  return store.getStore() !== undefined;
}
