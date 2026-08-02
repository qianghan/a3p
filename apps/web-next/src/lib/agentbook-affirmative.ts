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

export function lastBotMessageIsAboutExpense(
  lastBotMessage: string | null | undefined,
  active: ExpenseLike | null | undefined,
): boolean {
  if (!active) return false;
  if (!lastBotMessage) return true; // no evidence either way — behave as before

  const msg = lastBotMessage.toLowerCase();

  // The draft is normally echoed back with its amount, so that is the
  // strongest signal: "Recorded: $89.00 — office supplies at Staples".
  const dollars = (active.amountCents / 100).toFixed(2);
  const withoutCents = String(Math.round(active.amountCents / 100));
  if (msg.includes(dollars) || msg.includes(withoutCents)) return true;

  if (active.vendorName && msg.includes(active.vendorName.toLowerCase())) return true;
  if (active.description && msg.includes(active.description.toLowerCase().slice(0, 24))) return true;

  // Otherwise the bot must at least have been talking about booking something.
  return /\b(expense|receipt|categor|book this|confirm|business or personal)\b/.test(msg);
}
