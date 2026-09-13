import { describe, it, expect } from 'vitest';
import { carryForwardTopic } from '../followup-topic';

/**
 * Observed in production:
 *
 *   "What is my cash balance?" -> query-finance answered with the balance
 *   "Give me more details"     -> query-finance replied "More details about what?"
 *
 * The classifier sees the thread; the skill layer does not. Whatever the
 * classifier picks, the TEXT has to carry the topic.
 */

const CASH = [{ question: 'What is my cash balance?' }];

describe('carryForwardTopic', () => {
  it('the production case: a bare elaboration request inherits the topic', () => {
    expect(carryForwardTopic('Give me more details', CASH)).toBe(
      'Give me more details — regarding: "What is my cash balance?"',
    );
  });

  it('strips only the follow-up\'s own trailing punctuation', () => {
    expect(carryForwardTopic('more details?!', CASH)).toBe(
      'more details — regarding: "What is my cash balance?"',
    );
  });

  it('"why?" is an elaboration request', () => {
    expect(carryForwardTopic('why?', CASH)).toBe('why — regarding: "What is my cash balance?"');
  });

  it.each([
    'more',
    'elaborate',
    'explain that',
    'go on',
    'how so',
    'how come',
    'break that down',
    'what about that',
    'can you explain',
    'tell me more about it',
    'details please',
    'show me a bit more info',
  ])('recognises "%s"', (text) => {
    expect(carryForwardTopic(text, CASH)).toContain('regarding: "What is my cash balance?"');
  });

  it('leaves "and meals?" alone — carryForwardPeriod owns that shape', () => {
    expect(carryForwardTopic('and meals?', CASH)).toBe('and meals?');
  });

  it('leaves a question that carries its own topic alone', () => {
    const text = 'Why is my revenue down this quarter?';
    expect(carryForwardTopic(text, CASH)).toBe(text);
  });

  it('leaves a 7+-word message alone even if it opens like an elaboration', () => {
    const text = 'more details about the travel expenses from last month';
    expect(carryForwardTopic(text, CASH)).toBe(text);
  });

  it('is a no-op with no prior question', () => {
    expect(carryForwardTopic('Give me more details', [])).toBe('Give me more details');
    expect(carryForwardTopic('Give me more details', [{ question: null }])).toBe('Give me more details');
  });

  it('skips a prior turn that was itself a bare elaboration request', () => {
    // conversation is NEWEST-FIRST
    const convo = [
      { question: 'give me more details' },
      { question: 'more' },
      { question: 'What is my cash balance?' },
    ];
    expect(carryForwardTopic('more details', convo)).toBe(
      'more details — regarding: "What is my cash balance?"',
    );
  });

  it('ReDoS: a long non-matching input fails fast', () => {
    // Must test the FAILING match — a pattern that matches returns at the
    // first success and is fast however bad its backtracking is.
    const input = 'more '.repeat(4000) + 'zzz';
    const t0 = performance.now();
    expect(carryForwardTopic(input, CASH)).toBe(input);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
