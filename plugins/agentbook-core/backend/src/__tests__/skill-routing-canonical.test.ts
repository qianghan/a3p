import { describe, it, expect } from 'vitest';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';
import { selectSkillByPatterns } from '../skill-routing.js';

/**
 * Canonical-utterances regression suite. These cases exercise the routing
 * paths whose hardcoded `if (skill.name === X)` blocks were removed from
 * server.ts in Wave 2 PR 10 (G-011). The assertions encode the prior
 * behaviour so this rewrite is observably equivalent for the patterns we
 * actually shipped.
 *
 * IMPORTANT — `pickSkill` used to just walk BUILT_IN_SKILLS in array
 * declaration order and return the first match, "mirroring server.ts's
 * loop". That was the exact false premise a final whole-branch review
 * flagged: `db.abSkillManifest.findMany(...)` (server.ts, agent-brain.ts)
 * has no `orderBy`, so production's row order is *not* guaranteed to match
 * this array's order. A test helper that relies on array order can pass
 * while silently hiding a real two-skill collision (whichever skill the DB
 * happens to return first wins in prod, but the test never notices because
 * it always evaluates in the same fixed order).
 *
 * Fixed: pickSkill now evaluates every skill directly (order-independent),
 * and additionally cross-checks the winner against a few shuffled
 * evaluation orders. If declaration order and a shuffle disagree on which
 * skill wins, that's a genuine unresolved collision — surfaced as a thrown
 * error instead of silently returning whatever array position happened to
 * win.
 */

function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SHUFFLE_SEEDS = [7, 42, 1337];

function firstMatchIn(order: readonly (typeof BUILT_IN_SKILLS)[number][], text: string, lower: string): string | null {
  for (const skill of order) {
    if (selectSkillByPatterns(skill, text, lower)) return skill.name;
  }
  return null;
}

function pickSkill(text: string): string | null {
  const lower = text.toLowerCase();
  const declared = firstMatchIn(BUILT_IN_SKILLS, text, lower);

  for (const seed of SHUFFLE_SEEDS) {
    const shuffled = firstMatchIn(shuffle(BUILT_IN_SKILLS, seed), text, lower);
    if (shuffled !== declared) {
      throw new Error(
        `Order-dependent routing for "${text}": BUILT_IN_SKILLS declaration order picks "${declared}", ` +
        `but a shuffled evaluation order picks "${shuffled}" — this collision isn't resolved by ` +
        `excludePatterns and depends on array order, which production's DB query doesn't guarantee.`,
      );
    }
  }

  return declared;
}

describe('skill routing — canonical utterances', () => {
  const cases: Array<{ text: string; expected: string }> = [
    // record-expense — happy path
    { text: 'spent $5 on coffee', expected: 'record-expense' },
    { text: 'paid $42 for uber', expected: 'record-expense' },
    { text: 'bought $20 of office supplies', expected: 'record-expense' },

    // record-expense — exclusion: "what if" defers to simulate-scenario
    { text: 'what if I spent $500 less on meals', expected: 'simulate-scenario' },

    // record-expense — exclusion: leading "invoice " defers to create-invoice
    { text: 'invoice Acme $5000 for consulting', expected: 'create-invoice' },

    // record-expense — exclusion: "received payment" defers to record-payment
    { text: 'received payment of $1000 from Acme', expected: 'record-payment' },

    // record-expense — exclusion: leading "estimate " defers to create-estimate
    { text: 'estimate TechCorp $3000 for website work', expected: 'create-estimate' },

    // query-finance — happy path (no tax-specific words)
    { text: "what's my current balance", expected: 'query-finance' },

    // query-finance — excludes "how much tax" → tax-estimate
    { text: 'how much tax do I owe', expected: 'tax-estimate' },

    // query-finance — excludes "profit and loss" → pnl-report
    { text: 'show me profit and loss', expected: 'pnl-report' },

    // proactive-alerts — excludes "alert me when" → create-automation
    { text: 'alert me when I overspend on meals', expected: 'create-automation' },

    // create-automation — excludes "show my automations" → list-automations
    { text: 'show me my automations', expected: 'list-automations' },
    { text: 'list automations', expected: 'list-automations' },

    // review-queue — excludes tax-form review utterances
    { text: 'review t2125', expected: 'ca-t2125-review' },
    { text: 'review gst return', expected: 'ca-gst-hst-review' },

    // find-scholarships — search intent, not tax intent
    { text: 'find scholarships for a chemistry major in Ontario', expected: 'find-scholarships' },
    { text: 'search for need-based scholarships', expected: 'find-scholarships' },

    // scholarship-taxability — still wins on pure tax questions
    { text: 'is my scholarship taxable', expected: 'scholarship-taxability' },
    { text: 'is this grant taxable', expected: 'scholarship-taxability' },

    // find-coop-opportunities
    { text: 'find a co-op for summer 2027', expected: 'find-coop-opportunities' },
    { text: 'search for internships near campus', expected: 'find-coop-opportunities' },

    // find-roommate-matches
    { text: 'find me a roommate', expected: 'find-roommate-matches' },
    { text: 'show me compatible roommates', expected: 'find-roommate-matches' },

    // save-scholarship / save-coop-opportunity
    { text: 'save the first one', expected: 'save-scholarship' },
    { text: 'save that co-op opportunity', expected: 'save-coop-opportunity' },

    // record-personal-transaction (PR-1 personal-finance parity) — personal
    // income/spend phrasing, checked before record-expense in BUILT_IN_SKILLS.
    { text: 'I got paid $5,000 salary', expected: 'record-personal-transaction' },
    { text: 'I spent $80 on groceries from checking', expected: 'record-personal-transaction' },
    { text: 'put $50 into savings', expected: 'record-personal-transaction' },

    // record-personal-transaction — exclusion: plain business-style spend
    // phrasing (no personal-account signal) still defers to record-expense.
    { text: 'spent $45 on lunch', expected: 'record-expense' },

    // record-personal-transaction — exclusion: business-flagged language
    // defers to record-expense even when a personal account is mentioned.
    { text: 'I spent $50 on software for the business from my checking account', expected: 'record-expense' },

    // record-personal-transaction — exclusion: personal-snapshot's query
    // phrasing ("my savings rate" contains "my savings", a trigger for
    // record-personal-transaction, but it's a question, not a statement).
    { text: "what's my savings rate", expected: 'personal-snapshot' },

    // record-personal-transaction — negation-aware business-phrase check:
    // "not a business expense" contains the substring "business expense",
    // but the negation means this is NOT business-flagged language, so it
    // must NOT defer to record-expense.
    { text: 'I withdrew $80 from my checking, not a business expense', expected: 'record-personal-transaction' },
  ];

  for (const c of cases) {
    it(`"${c.text}" -> ${c.expected}`, () => {
      expect(pickSkill(c.text)).toBe(c.expected);
    });
  }
});

/**
 * `db.abSkillManifest.findMany(...)` (server.ts, agent-brain.ts) has no
 * `orderBy`, so once skills are seeded into the DB, row order — not this
 * array's order — decides which skill a first-match-wins loop sees first.
 * The record-expense / record-personal-transaction collision must therefore
 * resolve correctly regardless of which of the two is checked first: call
 * selectSkillByPatterns directly on each skill (bypassing array order
 * entirely) and assert exactly one of them claims each utterance.
 */
describe('record-expense / record-personal-transaction — mutually exclusive regardless of order', () => {
  const recordExpense = BUILT_IN_SKILLS.find((s) => s.name === 'record-expense')!;
  const recordPersonalTransaction = BUILT_IN_SKILLS.find((s) => s.name === 'record-personal-transaction')!;

  const cases: Array<{ text: string; expected: 'record-expense' | 'record-personal-transaction' | 'neither' }> = [
    { text: 'I got paid $5,000 salary', expected: 'record-personal-transaction' },
    { text: 'I spent $80 on groceries from checking', expected: 'record-personal-transaction' },
    { text: 'put $50 into savings', expected: 'record-personal-transaction' },
    { text: 'I withdrew $80 from my checking, not a business expense', expected: 'record-personal-transaction' },
    { text: 'spent $45 on lunch', expected: 'record-expense' },
    { text: 'spent $5 on coffee', expected: 'record-expense' },
    { text: 'I spent $50 on software for the business from my checking account', expected: 'record-expense' },
  ];

  for (const c of cases) {
    it(`"${c.text}" -> exactly ${c.expected} claims it, independent of evaluation order`, () => {
      const lower = c.text.toLowerCase();
      const expenseMatches = selectSkillByPatterns(recordExpense, c.text, lower);
      const personalMatches = selectSkillByPatterns(recordPersonalTransaction, c.text, lower);

      if (c.expected === 'record-expense') {
        expect(expenseMatches).toBe(true);
        expect(personalMatches).toBe(false);
      } else if (c.expected === 'record-personal-transaction') {
        expect(personalMatches).toBe(true);
        expect(expenseMatches).toBe(false);
      } else {
        expect(expenseMatches).toBe(false);
        expect(personalMatches).toBe(false);
      }
    });
  }
});

/**
 * Final whole-branch review, round 2: the record-expense/record-personal-
 * transaction fix above was correct but incomplete — two more real
 * collisions existed with record-personal-transaction, both missed because
 * the invoicing skills (record-payment, record-invoice-payment) had no
 * excludePatterns at all, and personal-snapshot's bare 'my personal'
 * trigger had no statement-vs-query guard:
 *
 *   1. record-payment and record-invoice-payment's bare "got paid" /
 *      "received payment" triggers also match personal-income phrasing
 *      ("I got paid $5,000 salary") with no way to defer to
 *      record-personal-transaction.
 *   2. personal-snapshot's 'my personal' trigger also matches a spend
 *      *statement* ("spent $50 on my personal account"), not just a query.
 *
 * As with the first pair, this must hold regardless of which skill a
 * DB-order-agnostic first-match loop evaluates first: call
 * selectSkillByPatterns directly on all five candidate skills (bypassing
 * array order and the `pickSkill` loop entirely) and assert exactly one
 * claims each utterance, including under several shuffled evaluation
 * orders.
 */
describe('record-payment / record-invoice-payment / personal-snapshot — defer to record-personal-transaction regardless of order', () => {
  const CANDIDATE_NAMES = ['record-personal-transaction', 'record-expense', 'record-payment', 'record-invoice-payment', 'personal-snapshot'] as const;
  const candidates = CANDIDATE_NAMES.map((name) => BUILT_IN_SKILLS.find((s) => s.name === name)!);
  candidates.forEach((s, i) => {
    if (!s) throw new Error(`Fixture setup error: skill "${CANDIDATE_NAMES[i]}" not found in BUILT_IN_SKILLS`);
  });

  const cases: Array<{ text: string; expected: (typeof CANDIDATE_NAMES)[number] }> = [
    { text: 'I got paid $5,000 salary', expected: 'record-personal-transaction' },
    { text: 'I got paid $250 salary, put it in my checking account', expected: 'record-personal-transaction' },
    { text: 'spent $50 on my personal account', expected: 'record-personal-transaction' },
    { text: 'I got paid for invoice INV-2026-0004', expected: 'record-invoice-payment' },
    { text: 'Acme paid the invoice', expected: 'record-invoice-payment' },
    { text: 'Client Beta LLC paid me', expected: 'record-invoice-payment' },
    { text: "how's my personal finance looking", expected: 'personal-snapshot' },
    { text: "what's my net worth", expected: 'personal-snapshot' },
    { text: 'I spent $80 on lunch', expected: 'record-expense' },
  ];

  for (const c of cases) {
    it(`"${c.text}" -> exactly ${c.expected} claims it among the 5 candidates, independent of evaluation order`, () => {
      const lower = c.text.toLowerCase();

      // 1. Declaration order: exactly one of the 5 named candidates matches,
      // and it's the expected one.
      const matched = candidates.filter((s) => selectSkillByPatterns(s, c.text, lower)).map((s) => s.name);
      expect(matched).toEqual([c.expected]);

      // 2. A handful of shuffled evaluation orders must agree — the set of
      // matching skills can't depend on which order they're checked in.
      for (const seed of SHUFFLE_SEEDS) {
        const shuffledMatched = shuffle(candidates, seed)
          .filter((s) => selectSkillByPatterns(s, c.text, lower))
          .map((s) => s.name)
          .sort();
        expect(shuffledMatched).toEqual([...matched].sort());
      }
    });
  }
});

/**
 * PR-3 (tax-fast-track-foundation), Task 4: start-tax-fast-track's triggers
 * pair filing-intent language with a prior-year anchor cue (last year/past
 * filing/past return/previous filing/previous return — see
 * TAX_FAST_TRACK_ANCHOR_PATTERN in skill-routing.ts), and tax-filing-start
 * gets a matching excludePatterns entry so an anchored phrase never matches
 * both simultaneously.
 *
 * Verified against the FULL tax-skill family named in the design spec's
 * "Revised: trigger design" section, not just tax-filing-start/
 * query-past-filings — using the same order-independent pickSkill()
 * (declaration order + 3 shuffled orders must agree) already established
 * above in this file.
 *
 * Note on the two illustrative phrasings below that use "previous filing"/
 * "last year's tax return" rather than the design doc's own literal examples
 * ("use my past filing to do this year's taxes" / "...based on last year's
 * return"): a bare "past filing" substring (no other qualifier) already
 * matches query-past-filings' own broad 'past.*filing' trigger regardless of
 * anything else in the message, and "last year's return" (without "tax"
 * between "year's" and "return") matches its "last year.?s return" trigger
 * too — both genuine, pre-existing collisions with query-past-filings that
 * are out of scope for this task (only tax-filing-start's manifest is edited
 * here, per the plan's Task 4 file list). Rephrasing with "previous filing"
 * (query-past-filings only fires on "previous tax filing", not bare
 * "previous filing") and inserting "tax" into "last year's tax return"
 * (matching the plan's own Task 4 collision example verbatim) sidesteps
 * both without weakening the anchor-cue requirement itself, which still
 * includes "past filing"/"past return" as valid alternatives in the actual
 * routing regex.
 */
describe('start-tax-fast-track vs. the full tax-skill family — no undefined double-match', () => {
  const TAX_FAMILY_NAMES = [
    'start-tax-fast-track', 'tax-filing-start', 'query-past-filings',
    'tax-filing-status', 'tax-filing-field', 'tax-filing-validate', 'tax-filing-export',
    'tax-filing-submit', 'tax-filing-check', 'tax-estimate', 'tax-deductions',
    'quarterly-payments', 'ca-t1-review', 'ca-t2125-review', 'ca-gst-hst-review', 'ca-schedule-1-review',
  ] as const;
  const family = TAX_FAMILY_NAMES.map((name) => BUILT_IN_SKILLS.find((s) => s.name === name)!);
  family.forEach((s, i) => {
    if (!s) throw new Error(`Fixture setup error: skill "${TAX_FAMILY_NAMES[i]}" not found in BUILT_IN_SKILLS`);
  });

  const cases: Array<{ text: string; expected: (typeof TAX_FAMILY_NAMES)[number] }> = [
    // start-tax-fast-track — filing-intent + anchor, various phrasings/orders.
    { text: "help me do this year's filing based on last year's tax return", expected: 'start-tax-fast-track' },
    { text: 'fast track my taxes from last year', expected: 'start-tax-fast-track' },
    { text: "use my previous filing to do this year's taxes", expected: 'start-tax-fast-track' },
    { text: "based on last year, help me prepare this year's tax filing", expected: 'start-tax-fast-track' },

    // tax-filing-start — no anchor cue present, still its own territory.
    { text: 'start my tax filing', expected: 'tax-filing-start' },
    { text: 'prepare my tax return', expected: 'tax-filing-start' },

    // query-past-filings — retrieving an old filing, no current-year intent.
    { text: 'show me my past filings', expected: 'query-past-filings' },
    { text: 'what was my NOA last year', expected: 'query-past-filings' },

    // Rest of the tax family — unrelated phrasing must not collide with the
    // new skill's broad-ish "this year...tax...last year" style triggers.
    { text: 'how much tax do I owe', expected: 'tax-estimate' },
    { text: 'what deductions can I claim', expected: 'tax-deductions' },
    { text: 'when is my quarterly tax payment due', expected: 'quarterly-payments' },
    { text: 'review my t1 general', expected: 'ca-t1-review' },
    { text: 'review t2125', expected: 'ca-t2125-review' },
    { text: 'review my gst return', expected: 'ca-gst-hst-review' },
    { text: 'review schedule 1', expected: 'ca-schedule-1-review' },
    { text: 'validate my tax filing before I submit', expected: 'tax-filing-validate' },
    { text: 'export my tax forms as a pdf', expected: 'tax-filing-export' },
    { text: 'submit my return to cra', expected: 'tax-filing-submit' },
    { text: 'did cra accept my filing', expected: 'tax-filing-check' },
    { text: "what's my tax filing status", expected: 'tax-filing-status' },
  ];

  // Scoped to the named tax-skill family (per the plan's Task 4 test
  // section), not the whole BUILT_IN_SKILLS array: query-finance's own bare
  // 'tax' triggerPattern has a pre-existing excludePatterns gap (it excludes
  // e.g. 'tax.*fil' and 'file.*tax' but not the reverse word order, "filing
  // ... tax" / "prepare my tax return" with no other tax-specific cue) that
  // already collides with tax-filing-start's own canonical phrase "prepare
  // my tax return" today, independent of anything in this task. That's a
  // real, pre-existing gap — but it's query-finance's excludePatterns list
  // that would need the fix, a skill outside this task's scope (built-in-
  // skills.ts's Task 4 edits are limited to start-tax-fast-track's new
  // manifest and tax-filing-start's excludePatterns) and outside the family
  // list the design/plan named for this verification. Flagged, not fixed,
  // here.
  for (const c of cases) {
    it(`"${c.text}" -> exactly ${c.expected} claims it among the tax-skill family, independent of evaluation order`, () => {
      const lower = c.text.toLowerCase();

      const matched = family.filter((s) => selectSkillByPatterns(s, c.text, lower)).map((s) => s.name);
      expect(matched).toEqual([c.expected]);

      for (const seed of SHUFFLE_SEEDS) {
        const shuffledMatched = shuffle(family, seed)
          .filter((s) => selectSkillByPatterns(s, c.text, lower))
          .map((s) => s.name)
          .sort();
        expect(shuffledMatched).toEqual([...matched].sort());
      }
    });
  }
});
