import { test, expect } from '@playwright/test';
import {
  PERSONA_CURRENCY,
  MIN_DOLLARS,
  MAX_DOLLARS,
  runTag,
  randomWholeDollars,
  todayIso,
  addDaysIso,
  escapeRegExp,
  placeholderRegex,
  moneyRegex,
  amountInputText,
  parsePnl,
  expenseCentsFor,
  suspenseAccountId,
  accountDelta,
  movedAccounts,
  diffTotals,
  pnlWindow,
  filterQuery,
} from './fixtures';

// Pure helpers behind the Docs journeys: no browser, no network, run in every invocation (like @mobile-helpers).
// Each assertion is a COMPUTED expectation (an exact string / number worked out here), not "it returned something".
test.describe('@mobile-fixtures', () => {
  test('persona currency table is derived from the one persona table', () => {
    expect(PERSONA_CURRENCY).toEqual({ maya: 'CAD', alex: 'USD', sydney: 'AUD' });
  });

  test('runTag is the exact upper-cased prefix + base36 time + entropy, search-safe and unique', () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(runTag('E2EDOCma', now, 'ab12cd')).toBe(`E2EDOCMA${now.toString(36).toUpperCase()}AB12CD`);
    const tags = Array.from({ length: 300 }, () => runTag('E2EDOCma'));
    expect(new Set(tags).size).toBe(300);
    for (const t of tags) {
      expect(t).toMatch(/^E2EDOCMA[0-9A-Z]+$/); // only characters a ?q= search and an ILIKE treat literally
      expect(t.length).toBeLessThan(40);
    }
    // Two runs in the same millisecond still differ (the entropy part), and a later time sorts into the string.
    expect(runTag('X', now, 'aaaaaa')).not.toBe(runTag('X', now, 'bbbbbb'));
    expect(runTag('X', now + 1, 'aaaaaa')).not.toBe(runTag('X', now, 'aaaaaa'));
  });

  test('randomWholeDollars asks for [101, 901) and returns whole dollars over the Home receipt threshold', () => {
    const asked: Array<[number, number]> = [];
    expect(randomWholeDollars((min, max) => (asked.push([min, max]), min))).toBe(101);
    expect(randomWholeDollars((min, max) => max - 1)).toBe(900);
    expect(asked).toEqual([[MIN_DOLLARS, MAX_DOLLARS + 1]]);
    for (let i = 0; i < 2000; i++) {
      const d = randomWholeDollars();
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(101);
      expect(d).toBeLessThanOrEqual(900);
    }
    // > $25 (2500 cents): every fixture is visible to the Home "missing receipt" predicate.
    expect(MIN_DOLLARS * 100).toBeGreaterThan(2500);
  });

  test('todayIso / addDaysIso are UTC calendar arithmetic (month, year and leap boundaries)', () => {
    expect(todayIso(new Date('2026-10-08T23:59:59Z'))).toBe('2026-10-08');
    expect(todayIso(new Date('2026-10-09T00:00:00Z'))).toBe('2026-10-09');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDaysIso('2026-10-08', 0)).toBe('2026-10-08');
    expect(addDaysIso('2026-10-08', -2)).toBe('2026-10-06');
  });

  test('pnlWindow spans two days back to tomorrow, so a fixture dated today and its reversal are both inside', () => {
    const w = pnlWindow(new Date('2026-10-08T12:00:00Z'));
    expect(w).toEqual({ startDate: '2026-10-06', endDate: '2026-10-09' });
    const today = Date.parse('2026-10-08T00:00:00Z');
    const reversalNow = Date.parse('2026-10-08T23:30:00Z');
    expect(Date.parse(w.startDate)).toBeLessThanOrEqual(today);
    expect(Date.parse(w.endDate)).toBeGreaterThanOrEqual(reversalNow);
  });

  test('escapeRegExp neutralises every metacharacter', () => {
    const raw = '$1.5+(a)[b]{c}|d^e*?\\';
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false);
  });

  test('placeholderRegex matches the sentence with the variable part free and everything else literal', () => {
    const re = placeholderRegex('Offline \u2014 showing your list saved at @@T@@.', '@@T@@');
    expect(re.test('Offline \u2014 showing your list saved at 3:04 PM.')).toBe(true);
    expect(re.test('Offline \u2014 showing your list saved at .')).toBe(false); // the variable part must not be empty
    expect(re.test('Offline - showing your list saved at 3:04 PM.')).toBe(false);
    expect(re.test('x Offline \u2014 showing your list saved at 3:04 PM.')).toBe(false); // anchored
    // regex metacharacters in the literal text stay literal
    expect(placeholderRegex('Saved (@@T@@) [ok]', '@@T@@').test('Saved (now) [ok]')).toBe(true);
    expect(placeholderRegex('a.b @@T@@', '@@T@@').test('aXb now')).toBe(false);
  });

  test('moneyRegex matches the whole figure the app prints, in the locale it prints it', () => {
    const usd = moneyRegex(347, 'USD', 'en-US');
    expect(usd.test('Fuel · Oct 8  $347')).toBe(true);
    expect(usd.test('$347')).toBe(true);
    expect(usd.test('$34')).toBe(false);
    expect(usd.test('$3,470')).toBe(false);
    expect(usd.test('$1,347')).toBe(false); // the tail of a longer number
    expect(usd.test('$3471')).toBe(false);
    expect(usd.test('$347.50')).toBe(false);
    expect(usd.test('2$347')).toBe(false); // glued to a digit in front
    // Sibling elements are joined with no separator by Playwright's text matching: a letter in front is fine.
    expect(usd.test('Oct 9, 2026 \u00B7 No category' + 'No receipt$347')).toBe(true);

    // en-US renders CAD as "CA$347"; en-CA as "$347" — each locale's own text, from the app's own formatter.
    expect(moneyRegex(347, 'CAD', 'en-US').test('CA$347')).toBe(true);
    expect(moneyRegex(347, 'CAD', 'en-US').test('No receiptCA$347')).toBe(true);
    expect(moneyRegex(347, 'CAD', 'en-CA').test('$347')).toBe(true);
    expect(moneyRegex(1235, 'CAD', 'en-CA').test('$1,235')).toBe(true);
    expect(moneyRegex(347, 'AUD', 'en-US').test('A$347')).toBe(true);
    expect(moneyRegex(347, 'AUD', 'en-AU').test('$347')).toBe(true);
    // fr-CA: number, U+00A0, symbol (not a plain space).
    const fr = moneyRegex(347, 'CAD', 'fr-CA');
    expect(fr.test('347 $')).toBe(true);
    expect(fr.test('1347 $')).toBe(false);
  });

  test('amountInputText is the locale decimal, two places, never grouped', () => {
    expect(amountInputText(347, 'en-US')).toBe('347.00');
    expect(amountInputText(1234, 'en-US')).toBe('1234.00');
    expect(amountInputText(354, 'fr-CA')).toBe('354,00');
    expect(amountInputText(12.5, 'en-US')).toBe('12.50');
  });

  const lines = (rows: Array<[string, string, number]>) =>
    rows.map(([accountId, code, amountCents]) => ({ accountId, code, name: `n${code}`, amountCents }));

  test('parsePnl builds per-account figures, sums repeated lines and survives junk', () => {
    const snap = parsePnl({
      grossRevenueCents: 1000,
      totalExpensesCents: 750,
      netIncomeCents: 250,
      expenses: [
        ...lines([['a1', '5100', 500], ['a2', '6999', 250], ['a1', '5100', 100]]),
        { accountId: 7, code: '1', amountCents: 9 }, // wrong id type: dropped
        null,
        { accountId: 'a3', code: '5200', amountCents: 'x' }, // bad amount: counts 0
      ] as unknown[],
    });
    expect(snap.totalExpensesCents).toBe(750);
    expect(snap.grossRevenueCents).toBe(1000);
    expect(snap.netIncomeCents).toBe(250);
    expect(snap.expenseByAccount).toEqual({ a1: 600, a2: 250, a3: 0 });
    expect(expenseCentsFor(snap, 'a1')).toBe(600);
    expect(expenseCentsFor(snap, 'zzz')).toBe(0);
    expect(suspenseAccountId(snap)).toBe('a2');
    expect(suspenseAccountId(parsePnl({ expenses: lines([['a1', '5100', 5]]) }))).toBeNull();
    expect(parsePnl(null)).toEqual({ grossRevenueCents: 0, totalExpensesCents: 0, netIncomeCents: 0, expenseByAccount: {}, codeByAccount: {} });
    expect(parsePnl({ expenses: 'nope' }).expenseByAccount).toEqual({});
  });

  test('accountDelta and movedAccounts report exactly what moved between two P&L snapshots', () => {
    const before = parsePnl({ totalExpensesCents: 900, expenses: lines([['x', '5100', 400], ['s', '6999', 500]]) });
    // $500 leaves the suspense account for category y: total unchanged, two accounts moved by +/-500.
    const after = parsePnl({ totalExpensesCents: 900, expenses: lines([['x', '5100', 400], ['y', '5200', 500]]) });
    expect(accountDelta(before, after, 's')).toBe(-500);
    expect(accountDelta(before, after, 'y')).toBe(500);
    expect(accountDelta(before, after, 'x')).toBe(0);
    expect(movedAccounts(before, after)).toEqual({ s: -500, y: 500 });
    expect(movedAccounts(before, before)).toEqual({});
    expect(after.totalExpensesCents - before.totalExpensesCents).toBe(0);
  });

  test('diffTotals names every differing field and is empty for equal snapshots', () => {
    const a: { expensesCents: number; monthNetCents: number | null; cashCents: number } = { expensesCents: 100, monthNetCents: null, cashCents: 5 };
    expect(diffTotals(a, { ...a })).toEqual([]);
    expect(diffTotals(a, { ...a, expensesCents: 130, monthNetCents: 7 })).toEqual(['expensesCents: 100 -> 130', 'monthNetCents: null -> 7']);
    // A field present on only one side is a difference, not silently equal.
    expect(diffTotals({ a: 1 } as Record<string, number>, { a: 1, b: 2 } as Record<string, number>)).toEqual(['b: undefined -> 2']);
  });

  test('filterQuery is the shared chip table, with caller params appended', () => {
    expect(filterQuery('needs-review')).toBe('status=pending_review');
    expect(filterQuery('no-category')).toBe('categoryId=none&isPersonal=false');
    expect(filterQuery('no-receipt')).toBe('hasReceipt=false&isPersonal=false');
    expect(filterQuery('archived')).toBe('archived=true');
    expect(filterQuery('all')).toBe('');
    expect(filterQuery('no-receipt', { limit: '100', q: 'a b' })).toBe('hasReceipt=false&isPersonal=false&limit=100&q=a+b');
  });
});
