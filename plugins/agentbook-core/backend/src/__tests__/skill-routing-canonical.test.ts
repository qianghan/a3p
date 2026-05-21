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
  ];

  for (const c of cases) {
    it(`"${c.text}" -> ${c.expected}`, () => {
      expect(pickSkill(c.text)).toBe(c.expected);
    });
  }
});
