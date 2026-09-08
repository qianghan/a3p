import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The 25 `js/polynomial-redos` patterns, checked for linear scaling.
 *
 * TWO THINGS THIS TEST HAS TO GET RIGHT, BOTH LEARNED THE HARD WAY.
 *
 * 1. It must time a FAILING match. A pattern that matches returns at the first
 *    success and is fast no matter how bad its backtracking is, so timing a
 *    hit proves nothing at all. Every input below ends with a character the
 *    pattern cannot consume, forcing the engine through the whole search.
 *
 * 2. It must measure the SHAPE of the curve, not an absolute duration. A
 *    threshold in milliseconds fails on a loaded CI runner and passes on a
 *    fast laptop regardless of complexity. Comparing n against 4n separates
 *    linear (~4x) from quadratic (~16x) with a wide margin either side.
 *
 * A related trap avoided: this never times an EXPONENTIAL pattern, because
 * running one to find out is itself the denial of service. Polynomial
 * backtracking at these input sizes is bounded and safe.
 */

const SRC = join(__dirname, '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

function medianMs(fn: () => void, runs = 5): number {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return ts.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

/** `build(n)` must produce an input of length ~n that the pattern CANNOT match. */
function assertLinear(name: string, re: RegExp, build: (n: number) => string) {
  const N = 4_000;
  const small = build(N);
  const large = build(N * 4);

  // Sanity: if either input matches, the timing below is meaningless.
  expect(re.test(small), `${name}: input must NOT match, or the timing proves nothing`).toBe(false);
  expect(re.test(large), `${name}: input must NOT match`).toBe(false);

  const t1 = Math.max(medianMs(() => re.test(small)), 0.05);
  const t2 = medianMs(() => re.test(large));
  const ratio = t2 / t1;

  // 4x input: linear ~4, quadratic ~16. 9 sits clear of both.
  expect(
    ratio,
    `${name}: ${t1.toFixed(2)}ms -> ${t2.toFixed(2)}ms at 4x input (ratio ${ratio.toFixed(1)})`,
  ).toBeLessThan(9);
}

/** Repeat a prefix so the engine has many candidate start positions. */
const spam = (prefix: string, n: number) =>
  (prefix + ' ').repeat(Math.ceil(n / (prefix.length + 1))).slice(0, n) + ' ';

describe('intent-classification gaps are bounded', () => {
  const CASES: Array<[string, RegExp, (n: number) => string]> = [
    ['register-business', /register.{0,30}business/, (n) => spam('register', n)],
    ['when-tax', /when .{0,40}(tax|file|due)/, (n) => spam('when a', n)],
    ['how-file-tax', /how.{0,30}file.{0,30}tax/, (n) => spam('how file', n)],
    ['total-spent', /total .{0,30}(spent|earned)/, (n) => spam('total a', n)],
    ['can-deduct', /can.{0,40}deduct/, (n) => spam('can', n)],
    ['where-money', /where.{0,30}money/, (n) => spam('where', n)],
    ['who-spend', /who.{0,30}spend/, (n) => spam('who', n)],
    ['if-then', /if.{1,200}then/i, (n) => spam('if', n)],
  ];
  it.each(CASES)('%s', (name, re, build) => assertLinear(name, re, build));
});

describe('extraction patterns are bounded', () => {
  const CASES: Array<[string, RegExp, (n: number) => string]> = [
    [
      'vendor-after-at-from',
      /(?:at|from|@)\s+([A-Z][A-Za-z0-9\s&']{0,60}?)(?:\s+today|\s+yesterday|\s*$)/,
      (n) => 'at ' + 'A'.repeat(n) + ' ',
    ],
    [
      'invoice-amount',
      /invoice\s+(.{1,80}?)\s+\$/i,
      (n) => 'invoice ' + 'a '.repeat(Math.ceil(n / 2)) + ' ',
    ],
    [
      'timer-label',
      /timer\s+(?:for\s+)?(.{1,80}?)(?:\s+project)?$/i,
      (n) => 'timer ' + 'a'.repeat(n) + '\n ',
    ],
    ['money-segment', /[^,$]{0,120}\$[\d,]{1,20}\.?\d{0,2}/i, (n) => 'x'.repeat(n)],
    ['trailing-amount', /\$?([\d,]{1,20}\.?\d{0,2})\s*$/, (n) => '1,'.repeat(Math.ceil(n / 2)) + 'Z'],
    ['trailing-punctuation', /[.!]{1,10}$/, (n) => '.'.repeat(n) + 'Z'],
    [
      'vendor-alias',
      /^\s*(?:vendor|merchant)?\s*["']?([\w&'. -]{1,40}?)["']?\s+(?:is|=|means)\s+["']?(.{1,120}?)["']?\s*$/i,
      (n) => 'vendor ' + 'a'.repeat(n) + ' is \n ',
    ],
    [
      'category-replacement',
      /(?:should be|make it)\s+(?:the\s+)?([A-Za-z][A-Za-z&' -]{0,60}?)\s*(?:\bcategory\b|\bnot\b|,|\.|!|$)/i,
      (n) => 'should be ' + 'a'.repeat(n) + '\n ',
    ],
  ];
  it.each(CASES)('%s', (name, re, build) => assertLinear(name, re, build));
});

describe('the source no longer contains the unbounded forms', () => {
  /**
   * The timing tests above run copies of the patterns. This asserts the real
   * files were actually changed — otherwise a future edit could restore `.*`
   * in the source while the test kept happily measuring its own literals.
   */
  const BANNED: Array<[string, string]> = [
    ['agent-brain.ts', 'register.*business'],
    ['agent-brain.ts', 'when .* (tax|file|due)'],
    ['agent-brain.ts', 'how.*file.*tax'],
    ['agent-brain.ts', 'total .*(spent|earned)'],
    ['server.ts', 'register.*business'],
    ['server.ts', 'how.*file.*tax'],
    ['server.ts', 'can.*deduct'],
    ['server.ts', 'is.*deductible'],
    ['server.ts', 'where.*money'],
    ['server.ts', 'who.*spend'],
    ['server.ts', 'top.*spend'],
    ['server.ts', 'spend.*most'],
    ['server.ts', '(.+?)\\s+\\$'],
    ["server.ts", "replace(/[.!]+$/, '')"],
    ['agent-planner.ts', '/if.+then/i'],
    ['agent-corrections.ts', "[A-Za-z&' -]*?"],
  ];

  it.each(BANNED)('%s no longer contains %s', (file, needle) => {
    expect(read(file)).not.toContain(needle);
  });
});

describe('bounding the gaps did not change classification', () => {
  /**
   * A bound is only safe if it is wider than real usage. These are the
   * messages the fallback table exists to catch; each must still be matched by
   * the bounded pattern that replaced its unbounded original.
   *
   * The failure mode this guards against is silent: a too-tight bound does not
   * error, it just stops recognising an intent, and the user gets the generic
   * reply instead of the right one.
   */
  const MATCHES: Array<[RegExp, string]> = [
    [/register.{0,30}business/i, 'how do i register my business in ontario'],
    [/when .{0,40}(tax|file|due)/i, 'when is my tax return due'],
    [/when .{0,40}(tax|file|due)/i, 'when do i need to file'],
    [/how.{0,30}file.{0,30}tax/i, 'how do i file my taxes this year'],
    [/how.{0,30}do.{0,30}tax/i, 'how do i do my taxes'],
    [/total .{0,30}(spent|earned)/i, 'total amount spent last month'],
    [/total .{0,30}(spent|earned)/i, 'total i earned in q3'],
    [/can.{0,40}deduct/i, 'can i deduct a home office'],
    [/can.{0,40}deduct/i, 'can i deduct the cost of my new laptop'],
    [/is.{0,40}deductible/i, 'is a laptop deductible'],
    [/where.{0,30}money/i, 'where did my money go last month'],
    [/who.{0,30}spend/i, 'who did i spend the most with'],
    [/top.{0,30}spend/i, 'top vendors i spend on'],
    [/spend.{0,30}most/i, 'which vendor do i spend most on'],
    [/if.{1,200}then/i, 'if revenue drops 20% then what happens to my runway'],
  ];

  it.each(MATCHES)('%s still matches %s', (re, msg) => {
    expect(re.test(msg)).toBe(true);
  });

  const EXTRACTIONS: Array<[string, RegExp, string, string]> = [
    ['vendor', /(?:at|from|@)\s+([A-Z][A-Za-z0-9\s&']{0,60}?)(?:\s+today|\s+yesterday|\s*$)/,
     'spent $24 at Starbucks today', 'Starbucks'],
    ['invoice client', /invoice\s+(.{1,80}?)\s+\$/i, 'invoice Acme Corp $5000 for consulting', 'Acme Corp'],
    ['timer label', /timer\s+(?:for\s+)?(.{1,80}?)(?:\s+project)?$/i, 'timer for the Acme redesign', 'the Acme redesign'],
    ['trailing amount', /\$?([\d,]{1,20}\.?\d{0,2})\s*$/, 'consulting 1,250.00', '1,250.00'],
  ];

  it.each(EXTRACTIONS)('%s still extracts correctly', (_name, re, input, expected) => {
    expect(re.exec(input)?.[1]).toBe(expected);
  });
});

describe('whitespace runs, the vector the first pass missed', () => {
  /**
   * The first version of this file bounded the `.` gaps and built its hostile
   * inputs out of repeated letters. CodeQL still flagged five patterns, and it
   * was right: the remaining ambiguity was in the `\s+` next to a lazy `.`
   * group. Because `.` matches a space too, a run of spaces can be divided
   * between the two quantifiers in many ways, and repeated letters never
   * exercise that split at all.
   *
   * Bounding the whitespace runs makes the number of divisions a constant.
   * These cases use spaces, so the gap cannot reopen unnoticed.
   */
  const CASES: Array<[string, RegExp, (n: number) => string]> = [
    [
      'invoice with a space run',
      /invoice\s{1,20}(.{1,80}?)\s{1,20}\$/i,
      (n) => 'invoice a' + ' '.repeat(n) + 'Z',
    ],
    [
      'quote with a space run',
      /(?:estimate|quote|proposal)\s{1,20}(.{1,80}?)\s{1,20}\$/i,
      (n) => 'quote a' + ' '.repeat(n) + 'Z',
    ],
    [
      'timer with a space run',
      /timer\s{1,20}(?:for\s{1,20})?(.{1,80}?)(?:\s{1,20}project)?$/i,
      (n) => 'timer a' + ' '.repeat(n) + '\n',
    ],
    [
      'vendor alias with a space run',
      /^\s{0,20}(?:vendor|merchant)?\s{0,20}["']?([\w&'. -]{1,40}?)["']?\s{1,20}(?:is|=|means)\s{1,20}["']?(.{1,120}?)["']?\s{0,20}$/i,
      (n) => ' '.repeat(n) + '\n',
    ],
    [
      'rename with a space run',
      /^\s{0,20}rename\s{1,20}["']?([\w&'. -]{1,40}?)["']?\s{1,20}to\s{1,20}["']?(.{1,120}?)["']?\s{0,20}$/i,
      (n) => 'rename ' + ' '.repeat(n) + '\n',
    ],
  ];
  it.each(CASES)('%s', (name, re, build) => assertLinear(name, re, build));

  it('still parses the real commands', () => {
    const alias = /^\s{0,20}(?:vendor|merchant)?\s{0,20}["']?([\w&'. -]{1,40}?)["']?\s{1,20}(?:is|=|means)\s{1,20}["']?(.{1,120}?)["']?\s{0,20}$/i;
    expect(alias.exec('vendor SQ COFFEE is Blue Bottle')?.slice(1, 3)).toEqual(['SQ COFFEE', 'Blue Bottle']);
    expect(alias.exec('merchant "AMZN Mktp" means Amazon')?.slice(1, 3)).toEqual(['AMZN Mktp', 'Amazon']);
    // `*` is outside the vendor character class, in the original too — asserted
    // so the bound is never blamed for a rejection it did not cause.
    expect(alias.exec('vendor SQ *COFFEE is Blue Bottle')).toBeNull();

    const rename = /^\s{0,20}rename\s{1,20}["']?([\w&'. -]{1,40}?)["']?\s{1,20}to\s{1,20}["']?(.{1,120}?)["']?\s{0,20}$/i;
    expect(rename.exec('rename AMZN Mktp to Amazon')?.slice(1, 3)).toEqual(['AMZN Mktp', 'Amazon']);

    const invoice = /invoice\s{1,20}(.{1,80}?)\s{1,20}\$/i;
    expect(invoice.exec('invoice Acme Corp $5000')?.[1]).toBe('Acme Corp');

    const timer = /timer\s{1,20}(?:for\s{1,20})?(.{1,80}?)(?:\s{1,20}project)?$/i;
    expect(timer.exec('timer for the Acme redesign')?.[1]).toBe('the Acme redesign');
  });
});
