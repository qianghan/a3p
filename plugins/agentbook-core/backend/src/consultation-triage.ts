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
  // A currency amount anywhere at all. "maybe log something for $5" carries no
  // imperative the patterns above recognise, but nobody types a dollar figure
  // to ask a general question about tax law.
  /[$£€]\s?\d/,
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
  // Sentence-final particles are checked by endsWithCjkQuestionParticle()
  // below, not here — see the note there.
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
  /\b(?:advice|advise)\b/i,
  // ── Chinese ───────────────────────────────────────────────────────────
  // Checked HERE, above DATA_QUESTION, for exactly the reason the English
  // entries are: 我应该预留多少税款？ ("how much tax should I set aside?")
  // contains 税, and 给我介绍一下今年报税的新规定 contains both 今年 and 税 —
  // the possessive rule below would claim both as ledger lookups. 应该 and
  // 规定 settle them, the same way "should i" and "regulations" settle their
  // English twins.
  /(?:应该|该不该|要不要|值得|建议|意见|推荐)/,
  /(?:规定|法规|规则|政策|合法|合规|资格|符合条件|截止日期|期限)/,
  // Tax RULES, not the user's tax. 税率 is the rate and 税法 is the law;
  // 我的税 is a number in their ledger. Without this, 今年的税率是多少？ reads
  // as a data question on 今年 + 税.
  /(?:税率|税法|税制)/,
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
  // Either order. "what deductions can I still claim" puts the noun BEFORE
  // the pronoun, and requiring noun-after-pronoun sent it to the advisor —
  // which cannot see their deductions.
  /\b(?:my|i|me)\b[^.?!]{0,40}\b(?:spend|spent|spending|owe[ds]?|balance|revenue|profit|income|expenses?|invoices?|receipts?|vendors?|clients?|budget|payroll|mileage|deductions?|refund|estimate|subscriptions?|recurring|alerts?)\b/i,
  /\b(?:spend|spent|spending|owe[ds]?|balance|revenue|profit|income|expenses?|invoices?|receipts?|vendors?|clients?|budget|payroll|mileage|deductions?|refund|estimate|subscriptions?|recurring|alerts?)\b[^.?!]{0,40}\b(?:my|i|me)\b/i,
  // receivables/payables phrasing that uses "me", not "my"
  /\b(?:who owes|owes me|i owe|owed to me|outstanding|unpaid|overdue)\b/i,
  // Possessive interrogatives — "what is my X", "is my X ready", "how is my X".
  // The user is asking about a thing they own, which lives in the ledger, not
  // about a rule. Caught by 'what is my bank reconciliation status' and
  // 'is my tax draft ready' diverting to the advisor and breaking two
  // established tests.
  // POSSESSIVE only — not "the". "what are THE new tax rules" is a question
  // about rules, not about anything the user owns, and including "the" here
  // swept the original reported utterance back onto the skill path.
  /^\s*(?:what(?:'?s| is| are)?|how(?:'?s| is| many| much)?|is|are|do i have|when(?:'?s| is)?)\s+my\b/i,
  // report verbs
  /^\s*(?:show|list|give me|what'?s my|whats my|how many|how much (?:did|do|have|is|are))\b/i,
  /\b(?:top|biggest|largest|most)\s+(?:vendors?|clients?|expenses?|categor)/i,
  /\b(?:summary|breakdown|report|overview|aging|p&l|profit and loss|balance sheet|trial balance)\b/i,
  // bare follow-ups in a data thread ("and meals?")
  /^\s*(?:and|what about|how about)\s+[a-z][a-z ]{0,20}\??$/i,

  // ── Chinese ───────────────────────────────────────────────────────────
  // Without these, EVERY Chinese question reached the `[?？]$` catch below
  // and went to the advisor, which cannot read the ledger. Observed on
  // production: 这个月我花了多少钱 answered "CA$192.00", and the same
  // sentence with a ？ answered "which kind of expenses did you mean?".
  //
  // First person or a period, then something that lives in the ledger. The
  // {0,14} window is bounded so the match stays inside one clause.
  /(?:我|我的|本月|这个月|上个月|今年|去年|本季度|上季度)[^。？?！!]{0,14}(?:花了|花费|支出|开支|收入|营收|利润|余额|结余|发票|账单|应收|应付|客户|供应商|预算|工资|薪资|里程|税)/,
  // 抵扣 (deduct) is deliberately NOT in that list. 我可以抵扣家庭办公室吗？
  // is a question about the RULES, and 吗 is the reliable signal for it —
  // the direct mirror of English "deduction" sitting in the consultative
  // half rather than the data half.
  /(?:谁欠我|欠我钱|欠我多少|未付|逾期|应收账款|拖欠)/,
  /(?:显示|列出|给我看|查一下|查询)/,
  /(?:报表|汇总|明细|概览|账龄|损益|资产负债|对账)/,
  // Bare follow-up inside a data thread — the mirror of "and meals?" above.
  // 那餐饮呢？ ends in 呢, so without this the particle check further down
  // claims it as a yes/no question and the thread changes destination
  // mid-conversation: turn one answered from the ledger, turn two from the
  // advisor. Placed here deliberately, ahead of that check, and kept short so
  // it only claims fragments.
  // The tail is ONE character class, not `\s*[？?]?\s*$`. Two `\s*` separated
  // by an optional, against an `$` anchor, is the quadratic shape that has now
  // appeared four times here — period-parse.ts, client-name.ts, the particle
  // check below, and very nearly this line. Timed in the ReDoS block.
  /^\s*(?:那|那么)?[^。？?！!]{0,8}呢[\s？?]*$/,
];

/**
 * Does the message end with a Chinese question particle (吗 / 呢 / 吧)?
 *
 * 可以抵扣吗 puts 抵扣 between 可以 and 吗, so a fixed 可以吗 pair misses the
 * most natural phrasing — the particle has to be matched where it actually
 * sits, at the end.
 *
 * A scan, not the obvious /[吗呢吧]\s*[?？]?\s*$/. Two `\s*` against an `$`
 * anchor is quadratic when the trailing run does not satisfy the anchor, and
 * the input is a chat message. CodeQL flagged it as js/polynomial-redos — the
 * third time in this codebase for the same shape, after /[?.!]+$/ in
 * period-parse.ts and again in client-name.ts. Scanning backwards is linear
 * and cannot regress into it.
 */
function endsWithCjkQuestionParticle(t: string): boolean {
  let i = t.length - 1;
  while (i >= 0 && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n')) i--;
  if (i >= 0 && (t[i] === '?' || t[i] === '？')) i--;
  while (i >= 0 && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n')) i--;
  return i >= 0 && (t[i] === '吗' || t[i] === '呢' || t[i] === '吧');
}

export type TurnKind = 'transactional' | 'consultative';

export interface TriageResult {
  kind: TurnKind;
  /** Why, for logs and for the eval's failure output. */
  reason: string;
}

/**
 * Ambiguity stays with the SKILL LAYER.
 *
 * My first version defaulted the other way, reasoning that booking a wrong
 * expense is worse than wasting a turn. That reasoning was faulty: the skill
 * layer does not book blindly. It gates destructive actions behind
 * confirmation, previews low-confidence intents instead of executing them, and
 * has its own clarify path — and it scores 97.5% on the canonical eval. Taking
 * ambiguous input away from it replaces a well-tested classifier with a
 * two-page regex file.
 *
 * The existing suite said so immediately: 'maybe log something for $5',
 * 'something vague' and a bank-reconciliation question all diverted to the
 * advisor and four established tests failed.
 *
 * So this only ever DIVERTS on positive evidence that the user wants an
 * explanation. Everything else routes exactly as it did before, which makes
 * the change additive rather than a rewrite of routing.
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

  if (endsWithCjkQuestionParticle(t)) {
    return { kind: 'consultative', reason: 'ends with a Chinese question particle' };
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

  return { kind: 'transactional', reason: 'no consultative signal — leave it with the skill layer' };
}
