/**
 * Channel-agnostic correction detection.
 *
 * Why this module exists
 * ----------------------
 * Correction handling used to live in exactly one place: an inline regex in the
 * Telegram adapter (apps/web-next/.../telegram/webhook/route.ts), which set
 * `req.feedback` before calling the brain. agent-brain.ts only entered its
 * correction path `if (feedback)`, so every other channel — web, the public
 * API, MCP, the nightly canonical eval — never reached it at all.
 *
 * The consequence was a money bug, confirmed by the 2026-07-30 canonical eval
 * (run 30578028815). In thread t-maya-amount-correction:
 *
 *     "lunch $42"           -> record-expense   (correct)
 *     "actually it was $52" -> record-expense   (WRONG)
 *
 * "actually it was $52" matches record-expense's `\$\d` trigger pattern, so the
 * follow-up booked a SECOND expense instead of editing the first. The user's
 * books showed $42 + $52 = $94 for one lunch — a silent double-count that also
 * inflated the deduction. The same root cause left
 * "no, that should be Travel category not Meals" unapplied.
 *
 * Keeping detection here — pure, exported, no DB and no LLM — means every
 * channel shares one implementation and the parsing is unit-testable on its own.
 * See __tests__/agent-corrections.test.ts.
 */

export type CorrectionIntent =
  | { kind: 'amount'; amountCents: number }
  | { kind: 'category'; category: string };

/**
 * Words that mark the message as a revision of something already said, rather
 * than a new instruction. A cue is necessary but never sufficient — see the
 * competing-entity and bare-cue guards below, plus the caller-side requirement
 * that the previous turn actually wrote an expense.
 */
import { parseAmountCents } from './parse-amount.js';

const AMOUNT_CUE = String.raw`actually|no|nope|wrong|oops|sorry|correction|i meant|meant`;

/**
 * A correction of an *amount*: a cue, then a money value, with only a short
 * connective gap between them ("actually it was $52", "no, should be $7").
 * The gap explicitly cannot contain a digit or a `$`, which stops this from
 * reaching across a clause into an unrelated number.
 */
const AMOUNT_AFTER_CUE = new RegExp(
  String.raw`\b(?:${AMOUNT_CUE})\b[^$\d]{0,24}?\$?\s*([\d,]+(?:\.\d{1,2})?)\b`,
  'i',
);

/**
 * Replacement phrasings that are corrections on their own, without needing a
 * separate cue word ("make that $52", "change it to $52", "it was $52").
 */
const AMOUNT_REPLACEMENT = new RegExp(
  String.raw`\b(?:make (?:that|it)|change (?:that|it) to|should (?:be|have been)|should've been|it was|it'?s)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\b`,
  'i',
);

/**
 * A correction of a *category*. The capture is deliberately lazy and must be
 * terminated by a boundary token.
 *
 * This is the bug that made cu-maya-050b fail. The previous implementation
 * (agent-memory.ts) used a greedy `(\w[\w\s&]*)`, so
 * "no, that should be Travel category not Meals" captured the whole tail —
 * "Travel category not Meals" — and the `abAccount.name contains` lookup found
 * nothing, so the recategorization silently did not happen and the reply never
 * mentioned Travel. Terminating on `category` / `not` / `instead` / `rather` /
 * punctuation keeps only the intended target ("Travel").
 */
const CATEGORY_REPLACEMENT =
  /(?:should be|should have been|make it|change (?:it|that) to|it'?s|that'?s)\s+(?:the\s+)?([A-Za-z][A-Za-z&' -]*?)\s*(?:\bcategory\b|\bnot\b|\binstead\b|\brather\b|,|\.|!|$)/i;

/**
 * Nouns that mean the message is about a different entity than the expense we
 * would be correcting. Without this, "and add a line for $500 consulting" or
 * "got $7500 payment from BigCo" could be mistaken for an amount correction.
 */
const COMPETING_ENTITY = /\b(invoice|estimate|bill|bills|payment|payroll|client|quote|timer|budget)\b/i;

/** Questions are never corrections, even when they contain a cue word. */
const QUESTION = /\?\s*$|^\s*(?:how|what|when|where|who|why|which|can|do|does|is|are|should i)\b/i;

/**
 * A bare "no" / "cancel" / "sorry" with nothing else is session control (or
 * politeness), not a correction. The session layer owns those.
 */
// The tail is ONE character class. `\s*[.!]?\s*$` — two quantifiers either
// side of an optional, against an anchor — is quadratic when the trailing run
// does not satisfy the anchor: "ok" + 40k spaces + "x" measured at 2547ms on a
// chat endpoint. Pre-existing and live; CodeQL only gates NEW alerts, so it
// never surfaced until the Chinese rules below reproduced the same shape.
const BARE_CUE = new RegExp(String.raw`^\s*(?:${AMOUNT_CUE}|cancel|stop|yes|ok)[\s.!]*$`, 'i');

/**
 * Chinese correction cues.
 *
 * Needed because of a change made alongside it: once parse-amount.ts learned
 * 元 and 块, "其实是 52 元" started yielding an amount. Without a Chinese cue
 * here that message falls past the correction gate into classification and
 * books a SECOND expense — exactly the double-book of #416, reintroduced for
 * Chinese speakers by the parser fix. Teaching the parser Chinese without
 * teaching this module Chinese is strictly worse than teaching it neither.
 */
const ZH_AMOUNT_CUE =
  /(?:其实|其實|不对|不對|错了|錯了|弄错|弄錯|应该是|應該是|我是说|我是說|更正|改成|改为|改為|不是)/;

/** Chinese questions. A question is never a correction. */
const ZH_QUESTION = /[？]\s*$|[吗嗎呢][\s？?]*$/;

/** Chinese nouns that mean a different entity than the expense being fixed. */
const ZH_COMPETING_ENTITY = /(?:发票|發票|账单|帳單|付款|收款|客户|客戶|报价|報價|预算|預算|工资|工資|计时|計時)/;

/** A bare Chinese cue with nothing else is session control, not a correction. */
const ZH_BARE_CUE = /^\s*(?:不对|不對|错了|錯了|取消|停止|好的|是的|对|對)[\s。！!.]*$/;

function toCents(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  // Round rather than truncate so "$52.555" doesn't silently lose a cent.
  return Math.round(n * 100);
}

/**
 * Parse a follow-up utterance into the correction it expresses, or null when it
 * is not a correction.
 *
 * Conservative by design: this now runs on every inbound message, so a false
 * positive would hijack a legitimate fresh intent. Callers must ALSO confirm
 * that the immediately-preceding turn wrote an expense before acting on the
 * result — "actually it was $52" only means "fix the last expense" when there
 * is a last expense to fix.
 */
export function detectCorrection(text: string): CorrectionIntent | null {
  if (!text || !text.trim()) return null;
  if (BARE_CUE.test(text) || ZH_BARE_CUE.test(text)) return null;
  if (QUESTION.test(text) || ZH_QUESTION.test(text)) return null;
  if (COMPETING_ENTITY.test(text) || ZH_COMPETING_ENTITY.test(text)) return null;

  // Chinese amount correction. Gated on a cue exactly like the English rules,
  // and delegating the number to the one shared parser rather than growing a
  // fourth copy of the money regex.
  if (ZH_AMOUNT_CUE.test(text)) {
    const zhCents = parseAmountCents(text);
    if (zhCents !== null && zhCents > 0) return { kind: 'amount', amountCents: zhCents };
  }

  // Amount first: "$52" can never be a category name, and checking it first
  // keeps the two branches from competing over phrasings like "it's $52".
  const amountMatch = AMOUNT_AFTER_CUE.exec(text) ?? AMOUNT_REPLACEMENT.exec(text);
  if (amountMatch) {
    const amountCents = toCents(amountMatch[1]);
    if (amountCents !== null) return { kind: 'amount', amountCents };
  }

  const categoryMatch = CATEGORY_REPLACEMENT.exec(text);
  if (categoryMatch) {
    const category = categoryMatch[1].trim().replace(/\s+/g, ' ');
    if (category) return { kind: 'category', category };
  }

  return null;
}
