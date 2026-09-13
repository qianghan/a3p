import { describe, it, expect } from 'vitest';
import {
  reviewConsultation,
  reviewDeterministic,
  verdictFor,
  repairBrief,
  safeFallback,
  type GroundingContext,
} from '../consultation-review';

/**
 * The two shipped hallucinations this module exists to stop:
 *
 *   #404  the agent volunteered "save ~$800" from a bracket-timing
 *         calculation built on a stale copy of the rate tables with an
 *         inverted trigger. The dollar figure corresponded to nothing.
 *   #432  a Canadian consultant was told meals are "typically deductible
 *         (50% in the US)". The rate was right; the authority was wrong.
 *
 * Both are decidable without a model, which is the whole design argument: an
 * LLM asked to review its own kind of output mostly approves it.
 */
const CA_CTX: GroundingContext = {
  jurisdiction: 'ca',
  facts: [
    'Total expenses: CA$29,271.79 across 42 transactions',
    'Meals and entertainment: CA$1,240.00',
    'CRA limit on food, beverages and entertainment: 50%',
  ],
};

describe('an amount the books do not contain is blocked', () => {
  it('catches the invented "$800 saving"', () => {
    const draft = 'Shifting that invoice to January could save you about $800 in tax.';
    const r = reviewConsultation(draft, CA_CTX);
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.kind)).toContain('ungrounded-amount');
    expect(r.findings[0].span).toContain('800');
  });

  it('passes an amount that IS in the books', () => {
    const draft = 'You have spent CA$29,271.79 so far this year.';
    expect(reviewConsultation(draft, CA_CTX).verdict).toBe('pass');
  });

  it('matches a dollar figure against a cents value in the context', () => {
    // Facts commonly carry cents; answers show dollars. Requiring every caller
    // to pre-format its context would just mean the check gets skipped.
    const ctx: GroundingContext = { jurisdiction: 'au', facts: ['laptopCents: 420000'] };
    expect(reviewConsultation('That A$4,200 laptop now qualifies.', ctx).verdict).toBe('pass');
  });

  it('does not treat counts as money', () => {
    // "8 receipts" and "11 days" are not claims about the books. Flagging
    // every integer floods the findings until someone disables the reviewer.
    const draft = 'You have 8 receipts missing and the deadline is in 11 days.';
    const kinds = reviewDeterministic(draft, CA_CTX).map((f) => f.kind);
    expect(kinds).not.toContain('ungrounded-amount');
  });
});

describe('a rate the jurisdiction pack does not contain is downgraded, not shipped', () => {
  it('accepts the 50% that IS in the pack', () => {
    const draft = 'Business meals are 50% deductible under the CRA limit.';
    expect(reviewConsultation(draft, CA_CTX).verdict).toBe('pass');
  });

  it('flags a rate that is not', () => {
    const draft = 'You can claim 80% of that under the CRA rules.';
    const r = reviewConsultation(draft, CA_CTX);
    expect(r.findings.map((f) => f.kind)).toContain('unverified-rate');
    // Repair, not block: the answer is salvageable without the number.
    expect(r.verdict).toBe('repair');
  });
});

describe("another country's tax authority is blocked", () => {
  it('catches the IRS being quoted to a Canadian', () => {
    const draft = 'Client meals are typically deductible (50% in the US) per IRS guidance.';
    const r = reviewConsultation(draft, CA_CTX);
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.kind)).toContain('foreign-authority');
  });

  it('allows the tenant\'s own authority', () => {
    expect(reviewConsultation('The CRA limit is 50%.', CA_CTX).verdict).toBe('pass');
  });

  it('blocks the ATO for a US tenant', () => {
    const us: GroundingContext = { jurisdiction: 'us', facts: ['Total: $1,000'] };
    const r = reviewConsultation('Lodge your BAS with the ATO.', us);
    expect(r.verdict).toBe('block');
  });

  it('does not flag an authority merely because another appears in the facts', () => {
    // The context legitimately mentions the CRA; that must not make a clean
    // CA answer look foreign.
    expect(reviewConsultation('Your total is CA$29,271.79.', CA_CTX).findings).toHaveLength(0);
  });
});

describe('an answer that only asks a question is a finding', () => {
  it('catches the clarify loop', () => {
    const draft = 'Are you asking about Australian tax forms or something else related to Australia?';
    const kinds = reviewDeterministic(draft, CA_CTX).map((f) => f.kind);
    expect(kinds).toContain('no-answer');
  });

  it('allows a question that FOLLOWS an answer', () => {
    const draft =
      'Your meals came to CA$1,240.00 this year, and the CRA allows 50% of that. Want the breakdown by month?';
    const kinds = reviewDeterministic(draft, CA_CTX).map((f) => f.kind);
    expect(kinds).not.toContain('no-answer');
  });
});

describe('no grounding at all is a block, not a pass', () => {
  // The dangerous default. An answer produced with no context has nothing
  // behind any figure in it, and "we had no context" must not read as "fine".
  it('blocks a figure when the context is empty', () => {
    const empty: GroundingContext = { jurisdiction: 'us', facts: [] };
    expect(reviewConsultation('You could save $800.', empty).verdict).toBe('block');
  });

  it('still passes prose that asserts no figures', () => {
    const empty: GroundingContext = { jurisdiction: 'us', facts: [] };
    const draft = 'Keep every receipt for business meals — you will need them if you are audited.';
    expect(reviewConsultation(draft, empty).verdict).toBe('pass');
  });
});

describe('the repair brief is specific enough to act on', () => {
  it('names the figure to remove and forbids substituting another', () => {
    const r = reviewConsultation('This saves about $800.', CA_CTX);
    const brief = repairBrief(r.findings);
    expect(brief).toContain('$800');
    expect(brief).toMatch(/Do not replace it with another number/i);
  });

  it('tells the model to keep the language', () => {
    // The transcript that started this switched from Chinese to English
    // mid-thread; a repair pass must not be another chance to do that.
    expect(repairBrief(reviewConsultation('Saves $800.', CA_CTX).findings))
      .toMatch(/Keep the same language/i);
  });
});

describe('the fallback says less rather than guessing', () => {
  it('names the tenant\'s own authority', () => {
    expect(safeFallback('ca')).toContain('CRA');
    expect(safeFallback('au')).toContain('ATO');
    expect(safeFallback('us')).toContain('IRS');
  });

  it('contains no figure of its own', () => {
    for (const j of ['us', 'ca', 'au', 'uk']) {
      expect(safeFallback(j)).not.toMatch(/\$\s?\d|\d+\s?%/);
    }
  });
});

describe('verdict severity ordering', () => {
  it('an ungrounded amount outranks a mere rate', () => {
    expect(verdictFor([
      { kind: 'unverified-rate', span: '80%', detail: '' },
      { kind: 'ungrounded-amount', span: '$800', detail: '' },
    ])).toBe('block');
  });

  it('no findings is a pass', () => {
    expect(verdictFor([])).toBe('pass');
  });
});

describe('a rate the pack publishes is grounded — and only from the pack', () => {
  /**
   * The suppression bug. `facts` held the tenant's ledger and nothing else,
   * so every percentage the model produced was "unverified" and the repair
   * brief instructed it to delete the number and say the rate "depends on
   * their circumstances". A reviewer built to stop invented figures was
   * deleting the true ones.
   */
  const ledger = ['Business expenses year to date: A$12,400.00 across 31 transactions.'];

  it('passes "GST is 10%" once the pack supplies the rate', () => {
    const draft = 'GST in Australia is 10%, so on that invoice you would add ten per cent.';
    const before = reviewConsultation(draft, { jurisdiction: 'au', facts: ledger });
    expect(before.verdict).toBe('repair');
    expect(before.findings[0].kind).toBe('unverified-rate');

    const after = reviewConsultation(draft, {
      jurisdiction: 'au', facts: ledger,
      jurisdictionRates: ['GST rate: 10%.'],
    });
    expect(after.verdict).toBe('pass');
  });

  it('still strips a rate the pack does NOT publish', () => {
    // The model does not get to supply its own. This is the whole point of
    // the check surviving the fix.
    const r = reviewConsultation('You can claim 87% of that.', {
      jurisdiction: 'au', facts: ledger,
      jurisdictionRates: ['GST rate: 10%.'],
    });
    expect(r.verdict).toBe('repair');
    expect(r.findings.map((f) => f.span)).toContain('87%');
  });

  it('lets the agent state a published threshold without blocking', () => {
    // A$75,000 is money-shaped, so before this it was an ungrounded-amount —
    // a BLOCK, not a repair. The GST registration advice could not be said.
    const draft = 'Registering for GST is compulsory once your turnover reaches A$75,000.';
    const blocked = reviewConsultation(draft, { jurisdiction: 'au', facts: ledger });
    expect(blocked.verdict).toBe('block');

    const ok = reviewConsultation(draft, {
      jurisdiction: 'au', facts: ledger,
      jurisdictionAmounts: ['GST registration becomes compulsory once GST turnover reaches A$75,000 over any 12 months.'],
    });
    expect(ok.verdict).toBe('pass');
  });

  it('does not let a pack RATE ground a money figure', () => {
    // 10 appears in the rates as "10%". A draft claiming the user has A$10 of
    // something must still be checked against their books, not against a
    // coincidence in the rate table.
    const r = reviewConsultation('You have A$10.00 sitting in that account.', {
      jurisdiction: 'au', facts: ledger,
      jurisdictionRates: ['GST rate: 10%.'],
    });
    expect(r.verdict).toBe('block');
    expect(r.findings[0].kind).toBe('ungrounded-amount');
  });

  it('still blocks an invented amount when the pack is fully supplied', () => {
    // The original failure: "save ~$800" from a bracket-timing calculation
    // that corresponded to no real quantity. Nothing here may rescue it.
    const r = reviewConsultation('Timing that purchase could save you about $800.', {
      jurisdiction: 'au', facts: ledger,
      jurisdictionRates: ['GST rate: 10%.', 'AU federal income tax marginal rates for 2025: 0%, 16%, 30%, 37%, 45%.'],
      jurisdictionAmounts: ['GST registration becomes compulsory once GST turnover reaches A$75,000 over any 12 months.'],
    });
    expect(r.verdict).toBe('block');
  });
});

describe('the catch-all bucket is allowed to answer with a question', () => {
  /**
   * The no-answer rule was written for the consultative-triage path: the user
   * asked an advisory question and must not be interrogated back. It was then
   * applied to the classifier's CATCH-ALL bucket too, where the correct reply
   * to "hello" IS a short question — so the reviewer repaired greetings into
   * safeFallback(), and production answered "hello" with "I can look this up
   * against your books, but I don't want to quote you a number I can't stand
   * behind…". The option lets the CALLER say which of the two jobs this is.
   */
  const GREETING = 'Hello! How can I help you with your accounting today?';

  it('flags the greeting by default — the consultative path is unchanged', () => {
    expect(reviewDeterministic(GREETING, CA_CTX).map((f) => f.kind)).toContain('no-answer');
    expect(reviewConsultation(GREETING, CA_CTX).verdict).toBe('repair');
  });

  it('passes the greeting when the caller allows a question-only reply', () => {
    expect(
      reviewDeterministic(GREETING, CA_CTX, { allowQuestionOnly: true }).map((f) => f.kind),
    ).not.toContain('no-answer');
    expect(reviewConsultation(GREETING, CA_CTX, { allowQuestionOnly: true }).verdict).toBe('pass');
  });

  it('still blocks an invented figure with the option on', () => {
    // Only the no-answer finding is waived. Every grounding check — the ones
    // that stop a wrong number reaching a user — stays on.
    const draft = 'That would save you about $800 — want me to check the dates?';
    const r = reviewConsultation(draft, CA_CTX, { allowQuestionOnly: true });
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.kind)).toContain('ungrounded-amount');
    expect(r.findings.map((f) => f.kind)).not.toContain('no-answer');
  });

  it('still catches the wrong tax authority with the option on', () => {
    const r = reviewConsultation('Should I look at your Schedule C?', CA_CTX, { allowQuestionOnly: true });
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.kind)).toContain('foreign-authority');
  });
});

describe('a figure the assistant already stated in this thread is grounded', () => {
  /**
   * Production, 2026-09-13. Turn 1, "What is my cash balance?", was answered
   * by the query-finance skill straight off the ledger:
   *
   *   You have CA$233,786.10 on hand.
   *   • Accounts Receivable: CA$216,860.00
   *   • Cash: CA$16,926.10
   *
   * Turn 2, "Give me more details", routes to the advisor instead. Its draft
   * restated those three figures — and the reviewer blocked two of them as
   * `ungrounded-amount`, because the grounding context was built from the
   * ledger snapshot and the profile and did NOT include the conversation. The
   * repair failed identically and the user got safeFallback().
   *
   * A number the assistant itself produced one turn ago is not the risk this
   * module exists for: it came out of the books by the same door the facts
   * do. The fix is to hand the recent ASSISTANT answers in as facts — which
   * only works if the extractor reads them, so that is what these two pin.
   * The first proves the extraction path by failing without the fact.
   */
  const ASSISTANT_TURN =
    'You have CA$233,786.10 on hand. • Accounts Receivable: CA$216,860.00 • Cash: CA$16,926.10';
  const FOLLOW_UP_DRAFT =
    'Your cash is CA$16,926.10 and receivables are CA$216,860.00; together CA$233,786.10.';
  const PROFILE = 'Business: consulting, sole proprietor in Ontario.';

  it('blocks the repeat when the thread is not among the facts', () => {
    const r = reviewConsultation(FOLLOW_UP_DRAFT, { jurisdiction: 'ca', facts: [PROFILE] });
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.span)).toContain('CA$16,926.10');
    expect(r.findings.map((f) => f.span)).toContain('CA$216,860.00');
  });

  it('passes the repeat when the assistant turn is one of the conversationFacts', () => {
    // The answer text goes in RAW — no re-formatting on the way. If the
    // extractor ever stopped reading "Cash: CA$16,926.10" out of a fact
    // string, the caller's normalisation would be the thing to change, and
    // this is the test that would say so.
    const r = reviewConsultation(FOLLOW_UP_DRAFT, {
      jurisdiction: 'ca',
      facts: [PROFILE],
      conversationFacts: [ASSISTANT_TURN],
    });
    expect(r.verdict).toBe('pass');
    expect(r.findings).toHaveLength(0);
  });

  it('still blocks a figure the thread never contained', () => {
    // Grounding on our own past answers widens what may be repeated. It must
    // not widen into "any number is fine now" — a total the assistant never
    // stated is still invented.
    const r = reviewConsultation(
      'Your cash is CA$16,926.10, so you could set aside CA$41,000 for tax.',
      { jurisdiction: 'ca', facts: [PROFILE], conversationFacts: [ASSISTANT_TURN] },
    );
    expect(r.verdict).toBe('block');
    expect(r.findings.map((f) => f.span)).toContain('CA$41,000');
  });

  it('never widens knownRates — a prior answer cannot license an invented rate', () => {
    // I1 / #404 again, wearing a different hat: `groundedNumbers` is
    // unit-blind, so if a prior answer's numbers were mixed into `facts`
    // wholesale, "due April 30, 2026" would license a later "your rate is
    // 30%". `conversationFacts` must widen `knownAmounts` only.
    const r = reviewConsultation('Your rate is 30%.', {
      jurisdiction: 'ca',
      facts: [PROFILE],
      conversationFacts: ['Your 2025 return is due April 30, 2026.'],
    });
    // unverified-rate alone downgrades to 'repair', not 'block' (see
    // verdictFor) — the point here is that it is NOT 'pass': the April 30
    // date in conversationFacts must not have licensed the 30% rate.
    expect(r.verdict).not.toBe('pass');
    expect(r.findings.map((f) => f.kind)).toContain('unverified-rate');
  });

  it('still grounds an amount the assistant stated, via conversationFacts', () => {
    const r = reviewConsultation('Cash: CA$16,926.10', {
      jurisdiction: 'ca',
      facts: [PROFILE],
      conversationFacts: ['Cash: CA$16,926.10'],
    });
    expect(r.findings.map((f) => f.kind)).not.toContain('ungrounded-amount');
  });
});
