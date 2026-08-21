import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

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
const store = new AsyncLocalStorage<OutboundLocale>();

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
  return store.run(resolveOutboundLocale(row), fn);
}

/** The current update's locale, or the en-US fallback outside any scope. */
export function botLoc(): OutboundLocale {
  return store.getStore() ?? OUTBOUND_FALLBACK;
}

/** Whether a scope is active. For tests and diagnostics, not for branching. */
export function hasBotLocale(): boolean {
  return store.getStore() !== undefined;
}
