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
