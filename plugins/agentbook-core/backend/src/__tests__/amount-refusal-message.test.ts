import { describe, it, expect } from 'vitest';
import { amountRefusalReason, noAmountMessage } from '../parse-amount';

/**
 * When the parser declines, say WHY.
 *
 * parse-amount.ts refuses ¥/RMB on purpose — it is a different currency from
 * every supported tenant, so booking ¥100 as $100 would be a silent FX error.
 * The refusal was right and the explanation was not: the user got
 *
 *     "I couldn't find the amount. Try including a number,
 *      e.g. Spent $45 on lunch"
 *
 * for "记录 ¥100 咖啡" — a message that is wrong twice over. The number is
 * right there, so the user reads it as the product being broken, and re-sends
 * the same thing. Nothing in the reply hints that currency is the issue, which
 * is the one thing they could actually act on.
 */

describe('the reason is distinguishable', () => {
  it.each([
    ['记录 ¥100 咖啡', 'foreign-currency'],
    ['花了 100 人民币', 'foreign-currency'],
    ['100 CNY', 'foreign-currency'],
    ['记录 四十二元 咖啡', 'unreadable-numeral'],
    ['两百元', 'unreadable-numeral'],
    ['log a coffee', 'no-amount'],
    ['记录一杯咖啡', 'no-amount'],
  ])('%s → %s', (t, want) => expect(amountRefusalReason(t)).toBe(want));

  it('is null when there IS an amount', () => {
    expect(amountRefusalReason('记录 42 元咖啡')).toBeNull();
    expect(amountRefusalReason('spent $42 on lunch')).toBeNull();
  });
});

describe('the message names the actual problem', () => {
  it('does not claim the number is missing when it is not', () => {
    const m = noAmountMessage('记录 ¥100 咖啡', 'expense');
    expect(m, 'still blames a missing number').not.toMatch(/couldn't find the amount|没找到金额/);
  });

  it('tells the ¥ user that currency is the issue and what to do', () => {
    const m = noAmountMessage('记录 ¥100 咖啡', 'expense');
    expect(m).toMatch(/¥|人民币/);
    // It has to say what would work, not just what did not.
    expect(m.length).toBeGreaterThan(20);
  });

  it('asks for digits when the numerals are the problem', () => {
    const m = noAmountMessage('记录 四十二元 咖啡', 'expense');
    expect(m).toMatch(/数字|digits/);
  });

  it('keeps the original guidance when the amount really is missing', () => {
    expect(noAmountMessage('log a coffee', 'expense')).toMatch(/couldn't find the amount/);
    expect(noAmountMessage('log a coffee', 'personal')).toMatch(/couldn't find the amount/);
  });
});

describe('it answers in the language the user wrote in', () => {
  const han = /[一-鿿]/;

  it.each([
    ['记录 ¥100 咖啡', 'expense'],
    ['记录 四十二元 咖啡', 'expense'],
    ['记录一杯咖啡', 'expense'],
    ['记录一杯咖啡', 'personal'],
  ] as const)('Chinese in → Chinese out: %s (%s)', (t, kind) => {
    expect(han.test(noAmountMessage(t, kind))).toBe(true);
  });

  it.each([
    ['log a coffee', 'expense'],
    ['I bought something', 'personal'],
  ] as const)('English in → English out: %s', (t, kind) => {
    expect(han.test(noAmountMessage(t, kind))).toBe(false);
  });

  it('gives the personal-transaction path its own examples', () => {
    // The two call sites in server.ts had different worked examples; a shared
    // helper must not flatten them into one.
    expect(noAmountMessage('log a coffee', 'expense'))
      .not.toBe(noAmountMessage('log a coffee', 'personal'));
  });
});

describe('the strings are actually in the languages they claim', () => {
  /**
   * Added after writing the Russian word "записать" into the middle of a
   * Chinese sentence and shipping it past 19 green tests. Every assertion
   * above checks for the PRESENCE of Han characters, and a stray Cyrillic word
   * does not disturb that — so the suite was blind to a message no reader of
   * either language could parse.
   */
  const STRAY_SCRIPT = /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿ]/;

  const everyMessage = (): string[] => {
    const out: string[] = [];
    for (const kind of ['expense', 'personal'] as const) {
      for (const t of ['记录 ¥100 咖啡', '记录 四十二元 咖啡', '记录一杯咖啡', 'log a coffee', '¥100', 'two hundred']) {
        out.push(noAmountMessage(t, kind));
      }
    }
    return out;
  };

  it('contains no Cyrillic, Greek, Hebrew or Arabic', () => {
    for (const m of everyMessage()) {
      expect(STRAY_SCRIPT.test(m), `stray script in: ${m}`).toBe(false);
    }
  });

  it('never mixes Han into an English message', () => {
    // ¥ is a symbol, not Han — an English message may legitimately name it.
    const en = noAmountMessage('log a coffee', 'expense') + noAmountMessage('two hundred', 'personal');
    expect(/[一-鿿]/.test(en)).toBe(false);
  });
});

describe('server.ts actually uses it', () => {
  /**
   * Mutation testing caught this: reverting server.ts to the hardcoded
   * "I couldn't find the amount." string failed nothing, because every test
   * above calls noAmountMessage directly. A helper nobody calls is a helper
   * that fixes nothing — the same shape as #444, where a carefully reconciled
   * skill array was built and then never handed to the classifier.
   */
  it('both amount paths go through noAmountMessage, with no literal left behind', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../server.ts'), 'utf8');

    expect(
      (src.match(/noAmountMessage\(/g) ?? []).length,
      'record-expense and record-personal-transaction should both call it',
    ).toBe(2);

    expect(
      src,
      'the misleading literal is back — it tells a ¥ user their number is missing',
    ).not.toMatch(/I couldn't find the amount/);
  });
});
