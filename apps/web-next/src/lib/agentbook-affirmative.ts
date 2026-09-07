/**
 * Pure predicate, deliberately NOT behind `server-only`.
 *
 * It lives outside agentbook-bot-agent.ts purely so it can be tested: that
 * module imports `server-only`, which the test environment refuses to load,
 * and an untestable guard is how the bug it prevents came back the first time.
 * Same reason agentbook-deduction-copy.ts was split out.
 */

/**
 * Did the bot's previous message actually refer to the active expense?
 *
 * A bare "yes" answers THE QUESTION THE BOT JUST ASKED. The fast path below
 * used to read it as confirming whatever expense happened to still be in
 * flight, however old and whatever the conversation had moved on to. Real
 * transcript: the bot asked "Are you asking about Australian tax forms?", the
 * user said yes, and it replied "I can't book this without a category."
 *
 * Rather than allow-list conversation topics — the vocabulary is open-ended
 * ('daily_briefing', 'review_queue', 'invoices', …) and any list rots — this
 * asks the narrower question the affirmative is actually answering: was the
 * last thing the bot said about this expense?
 *
 * Unknown last message returns true, preserving the normal receipt flow for
 * callers that do not track it. The check only ever REMOVES a wrong confirm.
 */
export interface ExpenseLike {
  amountCents: number;
  vendorName?: string | null;
  description?: string | null;
}

/**
 * Strip digit grouping and unify the decimal mark, so a formatted amount can
 * be compared against `toFixed(2)` regardless of locale.
 *
 *   "$1,234.56"  -> "$1234.56"
 *   "1 234,56 $" -> "1234.56 $"     (narrow no-break space, as fr-CA uses)
 *   "¥1,234.56"  -> "¥1234.56"
 *   "89,00 $"    -> "89.00 $"
 *
 * Grouping is removed only before exactly three digits, so a decimal comma is
 * not mistaken for a separator.
 */
export function normalizeAmounts(text: string): string {
  return text
    .replace(/(\d)[\s\u00a0\u202f,'](?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
}

export function lastBotMessageIsAboutExpense(
  lastBotMessage: string | null | undefined,
  active: ExpenseLike | null | undefined,
): boolean {
  if (!active) return false;
  if (!lastBotMessage) return true; // no evidence either way — behave as before

  const msg = lastBotMessage.toLowerCase();

  // The draft is normally echoed back with its amount, so that is the
  // strongest signal: "Recorded: $89.00 — office supplies at Staples".
  //
  // The comparison has to be separator-agnostic, and not only for other
  // locales. `toFixed(2)` yields "1234.56" while the reply is formatted by
  // Intl as "$1,234.56", so this check silently failed for every amount over
  // a thousand dollars in ENGLISH — the binding then fell through to the
  // keyword regex below, which does not match a plain "Recorded: … — office
  // supplies" either. fr-CA formats the same amount "1 234,56 $" and zh-CN
  // "¥1,234.56", so one normalisation covers all three.
  const dollars = (active.amountCents / 100).toFixed(2);
  const withoutCents = String(Math.round(active.amountCents / 100));
  const flat = normalizeAmounts(msg);
  if (flat.includes(dollars) || flat.includes(withoutCents)) return true;

  if (active.vendorName && msg.includes(active.vendorName.toLowerCase())) return true;
  if (active.description && msg.includes(active.description.toLowerCase().slice(0, 24))) return true;

  // Otherwise the bot must at least have been talking about booking something.
  return /\b(expense|receipt|categor|book this|confirm|business or personal)\b/.test(msg);
}
