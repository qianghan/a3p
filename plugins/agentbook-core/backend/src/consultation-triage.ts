/**
 * Is this turn a transaction or a conversation?
 *
 * The single structural defect behind the reported transcript. Today the brain
 * routes every utterance to one of 86 skills, and the advisory path is only
 * reached when routing returns null — which it almost never does, because with
 * 86 competitors something always matches a keyword. So "what are this year's
 * new AU tax rules?" gets handed to whichever data skill matched and comes back
 * as "I don't have anything to show for that right now."
 *
 * Consultation has to be decided BEFORE routing, not after it fails.
 *
 * Deterministic on purpose. An LLM triage call adds a round-trip to every
 * message and can be argued into anything; the distinction here is mostly
 * grammatical, and the cases where it is genuinely unclear are handled by the
 * tie-break below rather than by asking a model.
 */

/** An instruction to change the books. Beats everything else. */
const TRANSACTIONAL = [
  // money + a verb of record
  /(?:spent|paid|bought|charged|received|got|earned|invoice[ds]?|bill(?:ed)?)\b[^.?!]{0,40}?[$£€]\s?\d/i,
  /[$£€]\s?\d[\d,.]*\b[^.?!]{0,40}?\b(?:on|at|for|from|to)\b/i,
  // explicit imperatives against the ledger
  /^\s*(?:record|log|add|create|send|delete|remove|categorize|categorise|split|mark|start|stop|undo|fix)\b/i,
  /^\/\w+/,                                   // slash commands
  /\b(?:invoice|bill)\s+[A-Z][\w&'. ]{1,30}\s+[$£€]?\d/i,
  /\b\d+(?:\.\d+)?\s?(?:miles|km|kilometres|kilometers|hours|hrs)\b/i,
];

/**
 * Asking for understanding rather than an action.
 *
 * Multilingual by construction: the transcript that prompted this was Chinese,
 * and an English-only list would have mis-triaged it exactly as the old code
 * did. These are markers, not an exhaustive grammar — the tie-break carries
 * anything they miss.
 */
const CONSULTATIVE = [
  // advice-seeking
  /\b(?:should i|do i (?:need|have to)|can i|am i able to|is it worth|worth it|what happens if|what if)\b/i,
  /\b(?:advice|advise|recommend|suggest|opinion|priority|priorities|strategy|plan for)\b/i,
  // explanation-seeking
  /\b(?:what (?:is|are|does|do)|how (?:do|does|much (?:should|do i need)|can i)|why (?:is|do|does)|explain|tell me about|walk me through|difference between)\b/i,
  /\b(?:rules?|regulations?|requirements?|deadline|eligib|qualif|allowed|legal|compliance)\b/i,
  // the transcript's own shape, in Chinese/Japanese/Korean/Spanish/French
  /(?:介绍|规定|建议|应该|如何|为什么|能否|是否)/,
  // Sentence-final question particles. 可以抵扣吗 puts 抵扣 between 可以
  // and 吗, so a fixed 可以吗 pair misses the most natural phrasing.
  /[吗呢吧]\s*[?？]?\s*$/,
  /(?:について教え|どうすれば|べきですか)/,
  /(?:알려줘|어떻게|해야)/,
  /\b(?:qué debo|debería|cómo funciona|puedo deducir)\b/i,
  /\b(?:dois-je|devrais-je|comment fonctionne|puis-je déduire)\b/i,
];

/**
 * 'transactional' means "the skill layer handles this" — BOTH instructions
 * that change the books and questions ABOUT the books. Only 'consultative'
 * bypasses skills for the advisor.
 */
/**
 * Words that settle it regardless of any ledger noun in the sentence.
 *
 * "am I eligible for the small business deduction" contains "deduction", so
 * the possessive+ledger-noun rule below claimed it as a data lookup — but the
 * user is asking about ELIGIBILITY RULES, not what they have already claimed.
 * Eligibility, legality and "should I" are decisive; they are checked ahead of
 * DATA_QUESTION for that reason.
 */
const STRONG_CONSULTATIVE = [
  // Stems need \w* — `\beligib\b` cannot match "eligible", because the
  // trailing boundary fails against the following "l". Same anchoring
  // mistake as the month matcher and the CA$/A$ assertion.
  /\b(?:eligib\w*|qualif\w*|allowed to|permitted|legal|compliance|regulations?)\b/i,
  /\b(?:should i|do i need to|do i have to|is it worth|what happens if)\b/i,
  /\b(?:advice|advise|recommend)\b/i,
];

/**
 * A question about the user's OWN books. Goes to the skill layer, not the
 * advisor — query-expenses, aging-report and query-finance can answer these
 * from the ledger, and the advisor cannot.
 *
 * This category is the one I missed on the first pass, and it would have been
 * a serious regression: "how much did I spend on travel last month?",
 * "who owes me money?" and "what is my cash balance?" all end in a question
 * mark, so the interrogative fallback below swept every one of them to the
 * advisor. That is the working half of the product — the half scoring 97.5%
 * on the canonical eval.
 *
 * Checked BEFORE the consultative markers, because "how much should I set
 * aside for tax?" (advice) and "how much did I spend?" (data) share an opening.
 */
const DATA_QUESTION = [
  // possessive + a thing in the ledger
  /\b(?:my|i)\b[^.?!]{0,40}\b(?:spend|spent|spending|owe[ds]?|balance|revenue|profit|income|expenses?|invoices?|receipts?|vendors?|clients?|budget|payroll|mileage|deduction|refund|estimate)\b/i,
  // receivables/payables phrasing that uses "me", not "my"
  /\b(?:who owes|owes me|i owe|owed to me|outstanding|unpaid|overdue)\b/i,
  // report verbs
  /^\s*(?:show|list|give me|what'?s my|whats my|how many|how much (?:did|do|have|is|are))\b/i,
  /\b(?:top|biggest|largest|most)\s+(?:vendors?|clients?|expenses?|categor)/i,
  /\b(?:summary|breakdown|report|overview|aging|p&l|profit and loss|balance sheet|trial balance)\b/i,
  // bare follow-ups in a data thread ("and meals?")
  /^\s*(?:and|what about|how about)\s+[a-z][a-z ]{0,20}\??$/i,
];

export type TurnKind = 'transactional' | 'consultative';

export interface TriageResult {
  kind: TurnKind;
  /** Why, for logs and for the eval's failure output. */
  reason: string;
}

/**
 * Ambiguity resolves to CONSULTATIVE.
 *
 * Answering a question that turned out to be an instruction wastes a turn and
 * the user repeats themselves. Booking an expense that turned out to be a
 * question puts a wrong number in someone's books — which is what happened
 * when "是的" was read as confirming a stale draft. The costs are not
 * symmetric, so the default is not either.
 */
export function triageTurn(text: string): TriageResult {
  const t = (text ?? '').trim();
  if (!t) return { kind: 'consultative', reason: 'empty message' };

  for (const re of TRANSACTIONAL) {
    const m = t.match(re);
    if (m) return { kind: 'transactional', reason: `instruction to record: "${m[0].slice(0, 40)}"` };
  }

  for (const re of STRONG_CONSULTATIVE) {
    const m = t.match(re);
    if (m) return { kind: 'consultative', reason: `asks about rules: "${m[0].slice(0, 40)}"` };
  }

  for (const re of DATA_QUESTION) {
    const m = t.match(re);
    if (m) return { kind: 'transactional', reason: `question about their own books: "${m[0].slice(0, 40)}"` };
  }

  for (const re of CONSULTATIVE) {
    const m = t.match(re);
    if (m) return { kind: 'consultative', reason: `asks for understanding: "${m[0].slice(0, 40)}"` };
  }

  // A bare question mark, in any script, is a question.
  if (/[?？]\s*$/.test(t)) {
    return { kind: 'consultative', reason: 'ends with a question mark' };
  }

  // Short fragments ("coffee 12", "Staples") are how people log expenses on a
  // phone, and carry no interrogative signal. Anything longer that matched
  // nothing above is more likely a question phrased unusually.
  //
  // Length has to be script-aware. Chinese, Japanese and Korean are written
  // without spaces, so `split(/\s+/)` returns 1 for an entire sentence and
  // every CJK message would be read as a two-word fragment and booked. Count
  // characters for those scripts instead — this rule mis-triaged
  // "这个可以抵扣吗" ("can this be deducted?") as an expense before the fix.
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(t);
  const isShort = cjk ? t.replace(/\s/g, '').length <= 6 : t.split(/\s+/).length <= 4;
  if (isShort) {
    return { kind: 'transactional', reason: 'short fragment, typical of quick capture' };
  }

  return { kind: 'consultative', reason: 'no transactional signal (ambiguity favours answering)' };
}
