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
 * We mirror server.ts's loop: skills are tried in BUILT_IN_SKILLS order
 * and the first match wins.
 */

function pickSkill(text: string): string | null {
  const lower = text.toLowerCase();
  for (const skill of BUILT_IN_SKILLS) {
    if (selectSkillByPatterns(skill, text, lower)) return skill.name;
  }
  return null;
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
