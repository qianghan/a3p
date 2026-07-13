/**
 * Manifest-driven skill routing (Wave 2 PR 10, closes G-011).
 *
 * Replaces the prior hardcoded per-skill regex exclusion chain in
 * classifyAndExecuteV1 (server.ts). Each AbSkillManifest now carries
 * three pattern arrays:
 *
 *   triggerPatterns — at least one must match for the skill to be a
 *                     candidate (existing behaviour, unchanged).
 *   requirePatterns — if non-empty, ALL must match. Used for slot-style
 *                     preconditions (e.g. record-expense requires a $
 *                     amount).
 *   excludePatterns — if any matches, the skill is rejected. Used to
 *                     defer to a more specific skill (e.g. query-finance
 *                     defers to tax-estimate on "how much tax").
 *
 * Invalid regex strings are silently skipped — they never throw, so a
 * single broken pattern can't take down the whole router.
 */

export interface SkillLike {
  name: string;
  triggerPatterns?: unknown;
  requirePatterns?: unknown;
  excludePatterns?: unknown;
}

/**
 * Negation-aware "business expense" phrase detector, shared by:
 *   - record-personal-transaction's excludePatterns (defers to record-expense
 *     when the message is business-flagged) in built-in-skills.ts
 *   - record-expense's excludePatterns (defers back to record-personal-
 *     transaction for personal-account cues, *unless* business-flagged)
 *   - server.ts's businessFlag extraction for record-personal-transaction
 *
 * A naive substring match on "business expense" also fires on "not a
 * business expense" or "isn't a business expense", flipping the meaning of
 * what the user actually said. Guard with a negative lookbehind that treats
 * the phrase as flagged only when no negation word ("not", "isn't",
 * "wasn't", "no", "never", "don't", "doesn't", "didn't") appears within
 * ~25 characters before it.
 */
export const BUSINESS_PHRASE_PATTERN =
  "(?<!\\b(?:not|isn'?t|wasn'?t|no|never|don'?t|doesn'?t|didn'?t)\\b[\\s\\S]{0,25})" +
  "(?:for the business|business expense|that'?s a business|it'?s a business|business purchase)";

export function isBusinessFlaggedPhrase(text: string): boolean {
  try {
    return new RegExp(BUSINESS_PHRASE_PATTERN, 'i').test(text || '');
  } catch {
    return false;
  }
}

/**
 * Shared "personal account / paycheck" cue fragment, used to defer several
 * business/invoicing-flavoured skills to record-personal-transaction:
 *   - record-expense's excludePatterns (original, in built-in-skills.ts)
 *   - record-payment's and record-invoice-payment's excludePatterns (added
 *     alongside the record-expense/record-personal-transaction fix, closing
 *     the "I got paid $5,000 salary" / "...put it in my checking account"
 *     collision those two invoicing skills also had with
 *     record-personal-transaction — no DB `orderBy` means array position
 *     can't be relied on to pick the right one).
 *
 * Kept as a single source of truth so the cue list can't drift between the
 * three call sites.
 */
export const PERSONAL_ACCOUNT_CUE_PATTERN =
  'from (?:my )?checking|from (?:my )?savings|\\bmy checking\\b|\\bmy savings\\b|' +
  'into (?:my )?savings|to (?:my )?savings|personal account|\\bpaycheck\\b|' +
  '\\bsalary\\b|\\bwithdrew\\b|\\bwithdrawal\\b|\\bdeposited\\b';

/**
 * "Statement" shape used to keep personal-snapshot's bare `'my personal'`
 * trigger from firing on a transaction-recording statement like "spent $50 on
 * my personal account" (which should hit record-personal-transaction, not
 * the read-only net-worth/savings-rate query skill). Matches a dollar amount
 * plus a record-verb in either order.
 */
export const PERSONAL_STATEMENT_PATTERN =
  '\\$\\s*[\\d,]+\\.?\\d{0,2}.*\\b(?:spent|paid|put|deposited|withdrew|got)\\b|' +
  '\\b(?:spent|paid|put|deposited|withdrew|got)\\b.*\\$\\s*[\\d,]+\\.?\\d{0,2}';

/**
 * Personal-finance net-worth *trend* phrasing (PR-2, personal-finance-
 * trends-nudges). Used by personal-snapshot's triggerPatterns
 * (built-in-skills.ts) to add trend-shaped triggers on top of the existing
 * free current-state ones, and by server.ts's INTERNAL handler to run the
 * exact same cue check at execution time to decide free current-state vs.
 * gated trend sub-classification — single source of truth so the two
 * layers can't drift.
 *
 * Design constraint (see docs/superpowers/specs/2026-07-12-personal-
 * finance-trends-nudges-design.md): a bare temporal phrase like "over the
 * last year" must never be a trigger by itself — it must always be paired
 * with a personal/net-worth anchor, or it risks colliding with
 * query-finance's business-revenue-trend phrasing or query-past-filings'
 * year-anchored tax phrasing (first-match-wins, no `orderBy` on
 * `AbSkillManifest.findMany`, same hazard class as record-personal-
 * transaction's routing fixes). Anchors are intentionally the narrow set
 * personal-snapshot already triggers on (`net worth`, `household`,
 * `savings rate`, `personal finance`/`my personal`) — NOT `family budget`,
 * which would collide with query-budget's broad `how.*budget` trigger.
 */
export const PERSONAL_TREND_ANCHOR_PATTERN =
  'net worth|household|savings rate|personal finance|my personal';

export const PERSONAL_TREND_CUE_PATTERN =
  'trended|over time|compared to|vs\\.? last month|versus last month|\\bchange(?:d)?\\b';

/** Anchor-then-cue or cue-then-anchor, either order, within a short span. */
export const PERSONAL_TREND_TRIGGER_PATTERNS = [
  `(?:${PERSONAL_TREND_ANCHOR_PATTERN}).{0,40}(?:${PERSONAL_TREND_CUE_PATTERN})`,
  `(?:${PERSONAL_TREND_CUE_PATTERN}).{0,40}(?:${PERSONAL_TREND_ANCHOR_PATTERN})`,
];

/**
 * True iff `text` contains one of the comparison/temporal cues above.
 * Deliberately checks the cue alone (not anchor+cue) — by the time
 * server.ts's personal-snapshot handler runs, routing has already
 * guaranteed *some* personal/net-worth anchor matched (that's the only way
 * personal-snapshot gets selected at all); this just distinguishes which of
 * the two personal-snapshot triggers fired: a plain anchor (current-state,
 * free) or an anchor+cue combination (trend, gated).
 */
export function isPersonalTrendQuery(text: string): boolean {
  try {
    return new RegExp(PERSONAL_TREND_CUE_PATTERN, 'i').test(text || '');
  } catch {
    return false;
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function anyMatch(patterns: string[], lower: string): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(lower)) return true;
    } catch {
      // invalid regex — skip
    }
  }
  return false;
}

function allMatch(patterns: string[], lower: string): boolean {
  for (const p of patterns) {
    try {
      if (!new RegExp(p, 'i').test(lower)) return false;
    } catch {
      // invalid regex — treat as a non-match (conservative: require would fail)
      return false;
    }
  }
  return true;
}

/**
 * Returns true iff the skill should be selected for the given utterance.
 *
 * Order of checks:
 *   1. triggerPatterns must be non-empty AND at least one must match
 *   2. if requirePatterns non-empty, ALL must match
 *   3. if excludePatterns non-empty, NONE must match
 */
export function selectSkillByPatterns(
  skill: SkillLike,
  _text: string,
  lower: string,
): boolean {
  const triggers = toStringArray(skill.triggerPatterns);
  if (triggers.length === 0) return false;
  if (!anyMatch(triggers, lower)) return false;

  const requires = toStringArray(skill.requirePatterns);
  if (requires.length > 0 && !allMatch(requires, lower)) return false;

  const excludes = toStringArray(skill.excludePatterns);
  if (excludes.length > 0 && anyMatch(excludes, lower)) return false;

  return true;
}
