import { describe, it, expect } from 'vitest';
import {
  parsePeriodFromQuestion,
  extractPeriodPhrase,
  carryForwardPeriod,
} from '../period-parse';

// Fixed "now" so every window is deterministic. 2026-07-31 is a month END,
// which is where off-by-one window bugs surface.
const NOW = new Date(2026, 6, 31, 12, 0, 0);
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const window = (q: string) => {
  const p = parsePeriodFromQuestion(q, NOW);
  return `${day(p.startDate)}..${day(p.endDate)}`;
};

describe('month names are matched as WORDS, not substrings', () => {
  // The bug: month detection was `q.includes(name.slice(0, 3))`, so any
  // question containing the letters of a 3-char abbreviation was silently
  // answered for that month only. These are ordinary questions, and each one
  // returned a confidently wrong total.
  it('"Walmart" does not mean March', () => {
    // wal-MAR-t
    expect(window('how much did I spend at Walmart?')).toBe('2026-01-01..2026-07-31');
  });

  it('"the doctor" does not mean October — which would be a FUTURE window, i.e. $0', () => {
    // d-OCT-or. Asked in July, October 2026 has not happened, so the old
    // parser answered "no expenses found" to a user who has doctor bills.
    expect(window('how much did I spend at the doctor?')).toBe('2026-01-01..2026-07-31');
  });

  it('"marketing" does not mean March', () => {
    expect(window('what did I spend on marketing?')).toBe('2026-01-01..2026-07-31');
  });

  it('"innovation" does not mean November', () => {
    expect(window('what did I spend on innovation consulting?')).toBe('2026-01-01..2026-07-31');
  });

  it('"separate" does not mean September', () => {
    expect(window('can you separate my spending?')).toBe('2026-01-01..2026-07-31');
  });

  it('two false hits do not span a range — "Walmart in October" was Mar 1 – Oct 31', () => {
    expect(window('what did I spend at Walmart?')).toBe('2026-01-01..2026-07-31');
  });

  it('still matches a real month name', () => {
    expect(window('how much did I spend in June?')).toBe('2026-06-01..2026-06-30');
  });

  it('still matches a real 3-letter abbreviation used as a word', () => {
    expect(window('spending in Jun?')).toBe('2026-06-01..2026-06-30');
  });

  it('still matches a real month range', () => {
    expect(window('what did I spend between March and June?')).toBe('2026-03-01..2026-06-30');
  });
});

describe('"may" needs date context to count as a month', () => {
  it('the modal verb is not the month', () => {
    expect(window('what expenses may I deduct?')).toBe('2026-01-01..2026-07-31');
  });

  it('"Maya" is not the month', () => {
    expect(window('what did Maya spend?')).toBe('2026-01-01..2026-07-31');
  });

  it('"in May" IS the month', () => {
    expect(window('how much did I spend in May?')).toBe('2026-05-01..2026-05-31');
  });

  it('"May 2026" IS the month', () => {
    expect(window('spending for May 2026')).toBe('2026-05-01..2026-05-31');
  });
});

describe('relative periods', () => {
  it('"last month" is the previous CALENDAR month, not the trailing 30 days', () => {
    expect(window('how much did I spend last month?')).toBe('2026-06-01..2026-06-30');
  });

  it('"this month" starts at the 1st', () => {
    expect(window('what have I spent this month?')).toBe('2026-07-01..2026-07-31');
  });

  it('"last year" is the whole previous year', () => {
    expect(window('what did I spend last year?')).toBe('2025-01-01..2025-12-31');
  });

  it('a month named with "last year" uses last year', () => {
    expect(window('what did I spend in June last year?')).toBe('2025-06-01..2025-06-30');
  });

  it('an explicit year wins', () => {
    expect(window('what did I spend in June 2024?')).toBe('2024-06-01..2024-06-30');
  });

  it('a single month still in the future resolves to last year, not an empty window', () => {
    // Asked in July: "December" cannot mean Dec 2026 for an expense question.
    expect(window('what did I spend in December?')).toBe('2025-12-01..2025-12-31');
  });

  it('defaults to year-to-date', () => {
    expect(window('how much have I spent on software?')).toBe('2026-01-01..2026-07-31');
  });
});

describe('the window is always describable to the user', () => {
  // A wrong window is only harmless if the user can SEE it. Every parse must
  // carry a human-readable label, because the answer text quotes it.
  it('labels a named month with its year', () => {
    expect(parsePeriodFromQuestion('spend in June?', NOW).label).toBe('June 2026');
  });

  it('labels "last month" with the month it resolved to', () => {
    expect(parsePeriodFromQuestion('spend last month?', NOW).label).toBe('last month (June 2026)');
  });

  it('labels the default so year-to-date is never mistaken for "everything"', () => {
    expect(parsePeriodFromQuestion('total spend', NOW).label).toBe('year to date (Jan 1 – Jul 31, 2026)');
  });
});

describe('extractPeriodPhrase', () => {
  it('returns the literal phrase the user typed', () => {
    expect(extractPeriodPhrase('how much did I spend on travel last month?')).toBe('last month');
    expect(extractPeriodPhrase('what did I spend in June?')).toBe('June');
  });

  it('returns null when there is no period', () => {
    expect(extractPeriodPhrase('and meals?')).toBeNull();
    expect(extractPeriodPhrase('how much did I spend at Walmart?')).toBeNull();
  });
});

describe('carryForwardPeriod — a follow-up keeps the period of the question it follows', () => {
  // The eval failure: "how much did I spend on travel last month?" then
  // "and meals?" — the second turn was answered year-to-date, so the two
  // numbers the user was comparing covered different windows. Nothing in the
  // reply said so.
  const conv = (...questions: string[]) => questions.map((question) => ({ question, answer: '' }));

  it('inherits "last month" from the prior turn', () => {
    const out = carryForwardPeriod('and meals?', conv('how much did I spend on travel last month?'));
    expect(out).toBe('and meals last month?');
  });

  it('inherits a named month', () => {
    const out = carryForwardPeriod('what about software?', conv('what did I spend on travel in June?'));
    expect(out).toBe('what about software in June?');
  });

  it('persists across a chain of follow-ups', () => {
    // conversation is NEWEST-FIRST (see pairTurns) — the middle turn already
    // carries the period forward, so the third inherits it too.
    const out = carryForwardPeriod(
      'and software?',
      conv('and meals last month?', 'how much did I spend on travel last month?'),
    );
    expect(out).toBe('and software last month?');
  });

  it('does NOT override a period the follow-up states itself', () => {
    const out = carryForwardPeriod('and meals in May?', conv('travel last month?'));
    expect(out).toBe('and meals in May?');
  });

  it('leaves a non-continuation alone', () => {
    const text = 'how much did I spend on meals?';
    expect(carryForwardPeriod(text, conv('travel last month?'))).toBe(text);
  });

  it('leaves a long sentence alone even if it starts with "and"', () => {
    const text = 'and I would like to understand my meal spending in detail please';
    expect(carryForwardPeriod(text, conv('travel last month?'))).toBe(text);
  });

  it('is a no-op when no prior turn had a period', () => {
    expect(carryForwardPeriod('and meals?', conv('hello'))).toBe('and meals?');
  });

  it('is a no-op on an empty conversation', () => {
    expect(carryForwardPeriod('and meals?', [])).toBe('and meals?');
  });

  it('splits trailing punctuation in linear time (js/polynomial-redos)', () => {
    // Caught by CodeQL on the first version of this function, which used
    // `/[?.!]+$/`. An unanchored repeated character class matched against
    // end-of-string is quadratic when the run does NOT end the string: the
    // engine consumes the whole run from every start position, fails `$`, then
    // backtracks. Measured on the original: 10k chars 159ms, 20k 633ms,
    // 40k 2.5s, 80k 10.1s — 4x per doubling. A chat message is uncontrolled
    // input, so a single request could burn ten seconds of function CPU.
    //
    // The bound is deliberately loose (200k under a second, where the old code
    // needed about a minute) so this pins the complexity CLASS, not the speed
    // of whatever runner CI happened to give us.
    const hostile = 'and ' + '!'.repeat(200_000) + 'a';
    const started = Date.now();
    carryForwardPeriod(hostile, conv('travel last month?'));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('preserves a missing question mark', () => {
    expect(carryForwardPeriod('and meals', conv('travel last month?'))).toBe('and meals last month');
  });
});
