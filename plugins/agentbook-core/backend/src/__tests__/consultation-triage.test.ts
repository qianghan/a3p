import { describe, it, expect } from 'vitest';
import { triageTurn } from '../consultation-triage';

const kind = (t: string) => triageTurn(t).kind;

/**
 * The structural defect this decides.
 *
 * The brain routes every utterance to one of 86 skills and only reaches the
 * advisory path when routing returns null — which almost never happens,
 * because with 86 competitors something always matches a keyword. So the
 * reported "what are this year's new AU tax rules?" was handed to a data skill
 * and came back "I don't have anything to show for that right now."
 */
describe('the reported transcript triages correctly', () => {
  it.each([
    'What should be my priority',
    '给我介绍一下今年报税的新规定',
    'what are the new tax rules this year?',
    'should I incorporate?',
    'how much should I set aside for tax?',
    'explain the instant asset write-off',
    'am I eligible for the small business deduction',
    'what happens if I file late',
  ])('consultative: %s', (t) => expect(kind(t)).toBe('consultative'));
});

describe('instructions to change the books stay transactional', () => {
  it.each([
    'spent $42 on lunch',
    'paid AWS $1240 for hosting',
    'invoice Acme $5000 for consulting',
    'record a $30 taxi',
    'delete the last expense',
    'categorize it as Meals',
    '/briefing',
    'drove 47 miles to TechCorp',
    'got $7500 from BigCo',
  ])('transactional: %s', (t) => expect(kind(t)).toBe('transactional'));
});

describe('questions about the user\'s OWN books stay on the skill path', () => {
  // The category I missed on the first pass, and the one that would have hurt
  // most. Every one of these ends in a question mark, so the interrogative
  // fallback swept them all to the advisor — which has no ledger access. That
  // is the working half of the product, the half scoring 97.5% on the
  // canonical eval, and it would have collapsed silently.
  it.each([
    'how much did I spend on travel last month?',
    'what is my cash balance?',
    'who owes me money?',
    'show me my top vendors this quarter',
    'give me a summary of my expenses',
    'how many invoices are overdue?',
    'and meals?',
    'what did I spend on software this year?',
  ])('data question → skill layer: %s', (t) => expect(kind(t)).toBe('transactional'));

  it('distinguishes "how much did I spend" from "how much should I set aside"', () => {
    // Same opening words, opposite destinations: one is a ledger lookup, the
    // other is advice. This pair is why DATA_QUESTION is checked first.
    expect(kind('how much did I spend on meals?')).toBe('transactional');
    expect(kind('how much should I set aside for tax?')).toBe('consultative');
  });
});

describe('the tie-break favours answering, because the costs are not symmetric', () => {
  // Answering something that was an instruction wastes a turn. Booking
  // something that was a question puts a wrong number in the books — which is
  // exactly what "是的" did against a stale draft.
  it('an unrecognised longer sentence is consultative', () => {
    expect(kind('I have been wondering about the whole superannuation situation lately'))
      .toBe('consultative');
  });

  it('a bare question mark in any script is consultative', () => {
    expect(kind('澳大利亚的规则?')).toBe('consultative');
    // NOT "and meals?" — that is a follow-up DATA question about their own
    // books (see #429) and belongs on the skill path. An earlier version of
    // this file asserted both, which was a contradiction between two of my
    // own tests; the data-question reading is the correct one.
  });

  it('a short fragment is quick capture, not a question', () => {
    // "coffee 12" and "Staples" are how people log on a phone. Treating these
    // as consultative would break the fastest path in the product.
    expect(kind('coffee 12')).toBe('transactional');
    expect(kind('Staples')).toBe('transactional');
  });

  it('the short-fragment rule is script-aware', () => {
    // Chinese, Japanese and Korean are written WITHOUT SPACES, so
    // `split(/\s+/)` returns 1 for a whole sentence. A word-count heuristic
    // therefore reads every CJK message as a two-word fragment and books it.
    // Caught by "这个可以抵扣吗" ("can this be deducted?") triaging as an
    // expense — which would have mis-handled most Chinese input in the product.
    expect(kind('这个可以抵扣吗')).toBe('consultative');
    expect(kind('我今年需要交多少税')).toBe('consultative');
    // A genuinely short CJK capture still reads as one.
    expect(kind('咖啡 12')).toBe('transactional');
  });
});

describe('an instruction beats an interrogative in the same sentence', () => {
  it('"can you record $40 lunch" is a transaction', () => {
    // Contains "can i"-adjacent phrasing AND a real amount. The money wins:
    // the user is asking for an action, politely.
    expect(kind('can you record $40 lunch for me')).toBe('transactional');
  });

  it('"should I record this $40 lunch as business?" is still advice', () => {
    // No verb-of-record in the imperative; they are asking how to treat it.
    // This one is genuinely borderline and documented as such — the answer
    // should explain, then offer to book it.
    expect(kind('should I treat this lunch as business or personal?')).toBe('consultative');
  });
});

describe('multilingual by construction', () => {
  // An English-only marker list would mis-triage the exact transcript that
  // prompted this work.
  it.each([
    ['zh', '我应该如何报税'],
    ['zh', '这个可以抵扣吗'],
    ['es', '¿qué debo declarar este año?'],
    ['fr', 'dois-je facturer la TVA'],
  ])('%s consultative: %s', (_lang, t) => expect(kind(t)).toBe('consultative'));
});

describe('degenerate input', () => {
  it('empty is consultative, never a booking', () => {
    expect(kind('')).toBe('consultative');
    expect(kind('   ')).toBe('consultative');
  });

  it('gives a reason for every decision', () => {
    for (const t of ['spent $42 on lunch', 'should I incorporate?', '']) {
      expect(triageTurn(t).reason.length).toBeGreaterThan(0);
    }
  });
});
