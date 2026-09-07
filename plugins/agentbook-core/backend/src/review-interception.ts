/**
 * Should an in-progress tax review answer THIS message?
 *
 * The review interception in agent-brain runs before classification on every
 * surface, so while a review is active it answers every inbound message. That
 * is right for a review reply and wrong for everything else: reproduced on the
 * US tenant, "paid AWS $1240 for hosting" and "what is my cash balance?" both
 * came back as "I can update a number, answer a question about your filing…".
 *
 * Nobody types a spending verb and an amount to answer "which figure would you
 * like to change?". So a message that is plainly an instruction to the books
 * falls through to normal routing, and the review stays open.
 *
 * Lives in agentbook-core, not the tax plugin: it is a decision about message
 * SHAPE made by the router, and agent-brain must not import from
 * plugins/agentbook-tax (the cross-plugin boundary the review agent's plan
 * fixed deliberately).
 *
 * Deliberately conservative — it releases a message only on positive evidence
 * of a booking, so an unrecognised reply still reaches the review. A bare
 * number ("2400") is a field edit and must NOT escape.
 */
const BOOKING_INSTRUCTION = [
  // a spending/earning verb and money in the same clause, EN then ZH
  /(?:spent|paid|bought|charged|received|got|earned|invoice[ds]?|bill(?:ed)?|log)\b[^.?!]{0,40}?[$£€]\s?\d/i,
  /[$£€]\s?\d[\d,.]*\b[^.?!]{0,40}?\b(?:on|at|for|from|to)\b/i,
  /(?:记录|花了|花费|付了|支付|买了|消费)[^。？?]{0,20}?\d/,
  /\d[\d,.]*\s*(?:元|块钱|块|圆)/,
  // explicit imperatives against the ledger, with a figure
  /^\s*(?:record|log|add|create|send|categorize|categorise|split)\b[^.?!]{0,40}?\d/i,
  /^\/\w+/,
];

/** True when the active review should answer this message. */
export function isReviewInterceptable(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  return !BOOKING_INSTRUCTION.some((re) => re.test(t));
}
