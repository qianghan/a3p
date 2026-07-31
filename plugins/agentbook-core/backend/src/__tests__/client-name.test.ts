import { describe, it, expect } from 'vitest';
import { cleanClientName } from '../client-name';

/**
 * Found on production: Maya's client list held "to Acme for" sitting next to
 * "Acme Corp". The extractor captures everything between the verb and the
 * amount, so the most natural phrasings keep the grammar as part of the name,
 * and each variant creates a NEW client row.
 *
 * That splits one client's receivables across several records, which is what
 * makes it a money bug rather than a cosmetic one — "who owes me money?" and
 * the aging report both group by client.
 */
describe('grammar the extractor swallows is not part of the name', () => {
  it('"invoice Acme for $5000" is Acme, not "Acme for"', () => {
    expect(cleanClientName('Acme for')).toBe('Acme');
  });

  it('"invoice to Acme for $5000" is Acme, not "to Acme for"', () => {
    // The exact junk row found in production.
    expect(cleanClientName('to Acme for')).toBe('Acme');
  });

  it('"got $5000 from Acme yesterday" is Acme', () => {
    expect(cleanClientName('Acme yesterday')).toBe('Acme');
  });

  it('"payment from BigCo last week" is BigCo', () => {
    expect(cleanClientName('BigCo last week')).toBe('BigCo');
  });

  it('strips several trailing words in one pass', () => {
    expect(cleanClientName('Acme for last week')).toBe('Acme');
  });

  it('drops trailing sentence punctuation', () => {
    expect(cleanClientName('Acme Corp.')).toBe('Acme Corp');
  });

  it('collapses runs of whitespace', () => {
    expect(cleanClientName('  Acme   Corp  ')).toBe('Acme Corp');
  });
});

describe('real names survive intact', () => {
  // The risk of a cleaner is that it eats a legitimate name. These pin the
  // cases most likely to be damaged.
  it.each([
    'Acme Corp',
    'TechCorp Solutions',
    'WidgetCo Inc',
    'The Home Depot',        // leading article is NOT stripped
    'Ernst & Young',
    "O'Brien Consulting",
    'Verizon',               // ends in "on" but not as a word
    'Fortune Brands',
    'Atlas',
    'Forward Motion',        // ends in a word we strip only when standalone
  ])('%s is unchanged', (name) => {
    expect(cleanClientName(name)).toBe(name);
  });
});

describe('nothing usable means null, never a junk row', () => {
  // Callers must ask the user rather than fall back to the raw capture: a junk
  // name silently creates a duplicate client, which is worse than no name.
  it('returns null for empty or missing input', () => {
    expect(cleanClientName('')).toBeNull();
    expect(cleanClientName(null)).toBeNull();
    expect(cleanClientName(undefined)).toBeNull();
    expect(cleanClientName('   ')).toBeNull();
  });

  it('returns null when only grammar was captured', () => {
    expect(cleanClientName('to')).toBeNull();
    expect(cleanClientName('for')).toBeNull();
    expect(cleanClientName('to for')).toBeNull();
  });

  it('returns null for a capture with no letters', () => {
    expect(cleanClientName('123')).toBeNull();
    expect(cleanClientName('---')).toBeNull();
  });

  it('returns null for a run-on sentence rather than storing it as a client', () => {
    expect(cleanClientName('a'.repeat(61))).toBeNull();
    expect(cleanClientName('a'.repeat(60))).toBe('a'.repeat(60));
  });
});

describe('cleaning runs in linear time (js/polynomial-redos)', () => {
  // The first version used `/\s+(?:for|on|…)$/` inside a loop and
  // `/[,;:.!?]+$/` — both quadratic on a long run of the repeated character,
  // on chat text an attacker controls. CodeQL flagged both.
  //
  // The punctuation one was the SAME pattern fixed hours earlier in
  // period-parse.ts and written again here from habit, which is the argument
  // for a test rather than a resolution to be careful. The bounds are loose so
  // these assert the complexity class, not runner speed.
  it('a long run of spaces does not blow up the trailing-grammar loop', () => {
    const started = Date.now();
    cleanClientName('Acme' + ' '.repeat(100_000) + 'for');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a long run of punctuation does not blow up the trimmer', () => {
    const started = Date.now();
    cleanClientName('Acme' + '.'.repeat(100_000) + 'x');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses an absurdly long capture outright', () => {
    // Bounds every operation below it regardless of what the regexes do.
    expect(cleanClientName('Acme ' + 'x '.repeat(100_000))).toBeNull();
  });
});
