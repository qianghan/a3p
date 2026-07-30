import { describe, it, expect } from 'vitest';
import { detectCorrection } from '../agent-corrections.js';

/**
 * Regression guard for the money bug found by the 2026-07-30 canonical eval
 * (GitHub Actions run 30578028815).
 *
 * Thread t-maya-amount-correction:
 *   "lunch $42"           -> record-expense   (correct)
 *   "actually it was $52" -> record-expense   (WRONG — booked a SECOND expense,
 *                                             so the books showed $42 + $52 = $94
 *                                             for one lunch and the deduction was
 *                                             silently inflated)
 *
 * Thread t-maya-tim-hortons:
 *   "no, that should be Travel category not Meals" -> correction never applied
 *
 * `detectCorrection` is the channel-agnostic half of the fix: a pure parser so
 * the web/API/eval path gets the same correction detection Telegram had, and so
 * the parsing itself is testable without a DB or an LLM.
 */

describe('detectCorrection — amount corrections', () => {
  // The exact utterance that double-booked in production.
  it('detects the canonical "actually it was $52"', () => {
    expect(detectCorrection('actually it was $52')).toEqual({
      kind: 'amount',
      amountCents: 5200,
    });
  });

  it.each([
    ['no it was $52', 5200],
    ['actually, $52', 5200],
    ['make that $52', 5200],
    ['change that to $52', 5200],
    ['sorry it was 52 dollars', 5200],
    ['oops, $52.50', 5250],
    ['actually it was $1,250.99', 125099],
    ['no, should be $7', 700],
    ['i meant $52', 5200],
  ])('detects %j as an amount correction', (text, cents) => {
    expect(detectCorrection(text)).toEqual({ kind: 'amount', amountCents: cents });
  });
});

describe('detectCorrection — category corrections', () => {
  // The exact utterance whose recategorization was never applied.
  it('extracts only the target category from the canonical Tim Hortons utterance', () => {
    expect(detectCorrection('no, that should be Travel category not Meals')).toEqual({
      kind: 'category',
      category: 'Travel',
    });
  });

  it.each([
    ['no, that should be Travel', 'Travel'],
    ['that should be Travel not Meals', 'Travel'],
    ['should be Office Supplies', 'Office Supplies'],
    ['no, make it Travel instead', 'Travel'],
    ['change that to Travel', 'Travel'],
    ["no, it's Travel", 'Travel'],
  ])('detects %j as a category correction -> %s', (text, category) => {
    expect(detectCorrection(text)).toEqual({ kind: 'category', category });
  });

  // The pre-fix bug: a greedy capture swallowed the trailing "category not
  // Meals" into the category name, so the abAccount lookup never matched and
  // the correction silently did nothing.
  it('never captures the trailing "not <other category>" clause', () => {
    const got = detectCorrection('no, that should be Travel category not Meals');
    expect(got?.kind).toBe('category');
    expect((got as { category: string }).category).not.toMatch(/not|meals|category/i);
  });
});

describe('detectCorrection — must NOT hijack fresh intents', () => {
  it.each([
    // Fresh expense statements — the first turn of every thread.
    'lunch $42',
    'spent $89 on office supplies at Staples',
    'paid $42 at SBUX',
    'lunch at Tim Hortons today $15',
    // Session control words, handled by the session layer, not corrections.
    'no',
    'cancel',
    'yes',
    // Other entities that merely happen to carry an amount.
    'invoice BigCo $4000',
    'estimate Acme $3000 for the new project',
    'got $7500 payment from BigCo',
    'and add a line for $500 consulting',
    // Questions are never corrections.
    'how much will I owe in taxes this quarter?',
    'how much did I spend on travel last month?',
    'who owes me money?',
  ])('returns null for %j', (text) => {
    expect(detectCorrection(text)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectCorrection('')).toBeNull();
    expect(detectCorrection('   ')).toBeNull();
  });
});
