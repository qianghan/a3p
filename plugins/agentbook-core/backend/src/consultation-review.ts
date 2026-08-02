/**
 * Consultation review — verify an advisory answer before the user sees it.
 *
 * WHY THIS IS NOT "ASK AN LLM IF THE ANSWER IS GOOD".
 *
 * A model asked to review its own kind of output agrees with it most of the
 * time. A reviewer built that way produces the appearance of a safety
 * mechanism and catches close to nothing, which is worse than none: it makes
 * everyone downstream relax. So the load-bearing part here is DETERMINISTIC —
 * pull every money amount and rate out of the draft and check each one against
 * the grounding context that was supplied to produce it. A number the context
 * does not contain was invented, whatever the model says about it.
 *
 * This exists because the product already shipped the failure. The agent
 * volunteered "save ~$800" from a bracket-timing calculation that used a stale
 * copy of the rate tables and an inverted trigger — the dollar figure shown to
 * the user did not correspond to any real quantity. It also told a Canadian
 * consultant that meals are "typically deductible (50% in the US)", where the
 * rate was right and the authority was wrong. Both would be caught here.
 *
 * The LLM's role is narrowed to what arithmetic cannot judge — does this
 * actually answer the question, is it overconfident — and its verdict can only
 * DOWNGRADE. It is never allowed to approve a claim the deterministic pass
 * rejected.
 */

/** A jurisdiction's own revenue authority and the ones that must not appear. */
const AUTHORITIES: Record<string, RegExp> = {
  us: /\bIRS\b|Schedule C|1099|\bW-?2\b/i,
  ca: /\bCRA\b|T2125|\bT1\b|\bT4\b|GST\/HST/i,
  au: /\bATO\b|\bBAS\b|\bABN\b|superannuation/i,
  uk: /\bHMRC\b|Self Assessment|\bPAYE\b/i,
};

export type FindingKind =
  | 'ungrounded-amount'
  | 'unverified-rate'
  | 'foreign-authority'
  | 'no-answer'
  | 'review-unavailable';

export interface ReviewFinding {
  kind: FindingKind;
  /** The offending fragment, for logs and for the repair prompt. */
  span: string;
  detail: string;
}

export interface GroundingContext {
  /** 'us' | 'ca' | 'au' | 'uk' — the tenant's own. */
  jurisdiction: string;
  /**
   * Every fact the answer is allowed to assert, as raw text: the ledger
   * snapshot, the jurisdiction pack's rates and thresholds, the user's
   * profile. Numbers are extracted from this, so the format does not matter.
   */
  facts: string[];
}

export interface ReviewResult {
  /** pass: send it. repair: fix the findings and re-review. block: do not send. */
  verdict: 'pass' | 'repair' | 'block';
  findings: ReviewFinding[];
}

/**
 * Money amounts: $1,234.56 · CA$500 · A$3,240.00 · 1,234.56 USD
 *
 * Bare integers are deliberately NOT money. "8 receipts" and "11 days" are
 * counts, and demanding grounding for every integer floods the findings with
 * noise until someone turns the reviewer off. Currency-denominated figures are
 * the ones that misstate a user's books.
 */
const MONEY = /(?:[A-Z]{0,2}\$|£|€)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|CAD|AUD|GBP|EUR)\b/g;

/** Rates and thresholds: 50% · 12.5 % */
const RATE = /\b\d{1,3}(?:\.\d+)?\s?%/g;

/** Every number appearing anywhere in the grounding facts. */
function groundedNumbers(facts: string[]): Set<number> {
  const out = new Set<number>();
  for (const f of facts) {
    for (const m of f.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      const n = Number(m.replace(/,/g, ''));
      if (Number.isFinite(n)) {
        out.add(n);
        // Facts often carry cents ("amountCents: 324000") while the answer
        // shows dollars ("A$3,240"). Accept either side of that conversion
        // rather than forcing every caller to pre-format its context.
        if (Number.isInteger(n) && n % 100 === 0) out.add(n / 100);
        out.add(Math.round(n));
      }
    }
  }
  return out;
}

function toNumber(fragment: string): number | null {
  const digits = fragment.replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic pass. Everything here is decidable without a model.
 *
 * `facts` being empty means the answer was produced with no grounding at all,
 * so every figure in it is unverifiable — that is a block, not a pass. An
 * ungrounded advisory answer about someone's tax position is the failure this
 * module exists to prevent, and "we had no context" is the worst case, not an
 * excuse to skip the check.
 */
export function reviewDeterministic(draft: string, ctx: GroundingContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const known = groundedNumbers(ctx.facts);

  for (const span of draft.match(MONEY) ?? []) {
    const n = toNumber(span);
    if (n === null) continue;
    if (!known.has(n) && !known.has(Math.round(n))) {
      findings.push({
        kind: 'ungrounded-amount',
        span,
        detail: `${span} does not appear in the ledger or jurisdiction data supplied for this answer.`,
      });
    }
  }

  for (const span of draft.match(RATE) ?? []) {
    const n = toNumber(span);
    if (n === null) continue;
    if (!known.has(n)) {
      findings.push({
        kind: 'unverified-rate',
        span,
        detail: `${span} is not in the jurisdiction data for ${ctx.jurisdiction.toUpperCase()}. Rates must come from the pack, never from the model.`,
      });
    }
  }

  const own = ctx.jurisdiction.toLowerCase();
  for (const [code, pattern] of Object.entries(AUTHORITIES)) {
    if (code === own) continue;
    const hit = draft.match(pattern);
    if (hit) {
      findings.push({
        kind: 'foreign-authority',
        span: hit[0],
        detail: `"${hit[0]}" belongs to ${code.toUpperCase()}, but this tenant files in ${own.toUpperCase()}.`,
      });
    }
  }

  // An advisory turn that only asks a question is the clarify-loop failure:
  // the user asked twice and got interrogated twice. A question is fine AFTER
  // an answer, not instead of one.
  const trimmed = draft.trim();
  const sentences = trimmed.split(/[.!?。！？]\s*/).filter((s) => s.trim().length > 0);
  const onlyQuestions =
    sentences.length > 0 &&
    /[?？]\s*$/.test(trimmed) &&
    sentences.length <= 2;
  if (onlyQuestions) {
    findings.push({
      kind: 'no-answer',
      span: trimmed.slice(0, 80),
      detail: 'The reply only asks a question. Answer for the most likely case first, then offer to narrow.',
    });
  }

  return findings;
}

/**
 * Decide what to do with the findings.
 *
 * An amount the books do not contain is the one that ends up in a filing, so
 * it blocks. A rate we cannot verify is downgraded rather than blocked — the
 * answer can still be useful with the number removed and the user pointed at a
 * source. Naming another country's tax authority blocks, because it is exactly
 * the mistake that makes a user stop believing everything else.
 */
export function verdictFor(findings: ReviewFinding[]): ReviewResult['verdict'] {
  if (findings.some((f) => f.kind === 'ungrounded-amount' || f.kind === 'foreign-authority')) {
    return 'block';
  }
  if (findings.length > 0) return 'repair';
  return 'pass';
}

export function reviewConsultation(draft: string, ctx: GroundingContext): ReviewResult {
  const findings = reviewDeterministic(draft, ctx);
  return { verdict: verdictFor(findings), findings };
}

/**
 * Instructions for a repair attempt, derived from the findings.
 *
 * Given to the model as a rewrite brief. Deliberately concrete: "remove $800"
 * rather than "be more accurate", because the second produces another draft
 * with a different invented number.
 */
export function repairBrief(findings: ReviewFinding[]): string {
  const lines = findings.map((f) => {
    switch (f.kind) {
      case 'ungrounded-amount':
        return `- Remove the figure ${f.span}. It is not in the user's books. Do not replace it with another number; describe the situation without one.`;
      case 'unverified-rate':
        return `- Remove the rate ${f.span}. Say the rate depends on their circumstances and point them at the official guidance instead.`;
      case 'foreign-authority':
        return `- Remove "${f.span}". It is the wrong country's tax authority for this user.`;
      case 'no-answer':
        return '- Answer the question first using what you already know, then ask at most one follow-up.';
      default:
        return `- ${f.detail}`;
    }
  });
  return [
    'Your previous draft failed verification. Rewrite it, fixing exactly these:',
    ...lines,
    '',
    'Keep the same language and tone. Never invent a figure to replace a removed one.',
  ].join('\n');
}

/**
 * Last-resort answer when a draft cannot be repaired.
 *
 * Says less, and says it honestly. This is preferable to shipping a confident
 * wrong figure — the clarifying loop is annoying, a misfiling is not.
 */
export function safeFallback(jurisdiction: string): string {
  const authority =
    jurisdiction.toLowerCase() === 'ca' ? 'the CRA'
      : jurisdiction.toLowerCase() === 'au' ? 'the ATO'
        : jurisdiction.toLowerCase() === 'uk' ? 'HMRC'
          : 'the IRS';
  return (
    'I can look this up against your books, but I don\'t want to quote you a number ' +
    `I can't stand behind. Ask me about a specific figure in your account and I'll show you where it comes from — for the general rules, ${authority} is the source I'd trust.`
  );
}
