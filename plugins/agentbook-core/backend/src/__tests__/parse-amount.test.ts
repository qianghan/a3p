import { describe, it, expect } from 'vitest';
import { parseAmountCents } from '../parse-amount';

/**
 * "记录 42 元咖啡" answered "I couldn't find the amount."
 *
 * Chinese routing and Chinese replies both work; the amount parser was still
 * English-only — `$X`, an English verb, or the words dollars/bucks/cad/usd.
 * A Chinese speaker writes 42元 or 42块, matches none of them, and gets told
 * to include a number in a message that already had one.
 *
 * Two copies of that chain live in server.ts, on the regex path and the LLM
 * path, so fixing either alone leaves the other broken. This is the one
 * parser; agent-money-format.test.ts records the same lesson for the
 * formatters — "two copies of one rule is exactly what rots".
 */

const cents = (t: string) => parseAmountCents(t);

describe('English keeps working exactly as before', () => {
  it.each([
    ['spent $42 on lunch', 4200],
    ['paid AWS $1,240 for hosting', 124000],
    ['$5', 500],
    ['spent 42 on lunch', 4200],
    ['paid 132.99 for gas', 13299],
    ['30 dollars', 3000],
    ['12 bucks', 1200],
    ['500 cad', 50000],
    ['it was 89.50', 8950],
  ])('%s → %i', (t, want) => expect(cents(t)).toBe(want));

  it('finds nothing when there is nothing', () => {
    expect(cents('log a coffee')).toBeNull();
    expect(cents('')).toBeNull();
  });
});

describe('Chinese currency words book in the tenant\'s own currency', () => {
  /**
   * 元 and 块 are the generic unit, not a claim about China. Chinese names
   * every supported currency with 元 in it — 美元, 加元, 澳元 — and a Chinese
   * speaker in Toronto saying 42块 means CA$42, the same way an English
   * speaker says "42 bucks". So these book at par, no conversion.
   */
  it.each([
    ['记录 42 元咖啡', 4200],
    ['记录42元咖啡', 4200],
    ['花了 88 块', 8800],
    ['买咖啡花了12块钱', 1200],
    ['付了 1,240 元的服务器费用', 124000],
    ['13.50元', 1350],
    ['一杯咖啡 5 圆', 500],
  ])('%s → %i', (t, want) => expect(cents(t)).toBe(want));

  it('reads full-width digits, which a Chinese IME produces', () => {
    expect(cents('记录 ４２ 元咖啡')).toBe(4200);
  });
});

describe('万 and 千 are load-bearing, not decoration', () => {
  /**
   * The dangerous case. Matching digits-then-元 without handling the
   * multiplier reads 1万元 as 1 — a ten-thousand-fold understatement landing
   * silently in a ledger. Off-by-10000 is worse than not parsing at all.
   */
  it.each([
    ['买了台电脑 1万元', 1000000],
    ['1.5万元', 1500000],
    ['3千元', 300000],
    ['付了 2 万块', 2000000],
  ])('%s → %i', (t, want) => expect(cents(t)).toBe(want));

  it('never reads the digit and drops the multiplier', () => {
    // The specific regression: 1万元 → 100 cents.
    expect(cents('1万元')).not.toBe(100);
  });
});

describe('what it refuses to guess', () => {
  /**
   * A wrong number in the books is worse than a clarifying question. Both
   * cases below return null so the agent asks, rather than booking a figure
   * it had to invent.
   */
  it('does not book ¥ or RMB as if it were the tenant\'s currency', () => {
    // ¥ is CNY (or JPY). Every supported tenant books in USD, CAD or AUD, so
    // treating ¥100 as $100 is a silent FX error, not a parse.
    expect(cents('记录 ¥100 咖啡')).toBeNull();
    expect(cents('花了 100 人民币')).toBeNull();
    expect(cents('100 CNY')).toBeNull();
  });

  it('does not invent a number from Chinese numerals it cannot read', () => {
    // 四十二元 is 42, but half-parsing numerals is how you get 4 or 10.
    // Returning null makes the agent ask; it never books the wrong figure.
    expect(cents('记录 四十二元 咖啡')).toBeNull();
    expect(cents('两百元')).toBeNull();
  });

  it('does not mistake a duration or a count for money', () => {
    // The Chinese verb rule mirrors "spent 42 on lunch", and 花了3小时
    // ("spent 3 hours") is the shape that rule would otherwise swallow.
    expect(cents('花了 3 小时做报告')).toBeNull();
    expect(cents('开了 47 公里')).toBeNull();
    expect(cents('买了 3 个杯子')).toBeNull();
  });
});

describe('Chinese verbs work without a unit, like the English ones', () => {
  it.each([
    ['花了 42 买咖啡', 4200],
    ['支付 250 给设计师', 25000],
  ])('%s → %i', (t, want) => expect(cents(t)).toBe(want));
});

describe('runs in linear time', () => {
  it('does not blow up on a long input', () => {
    // Fourth ReDoS in this codebase came from a trailing-run pattern; this
    // parser is regex-heavy and gets untrusted chat text.
    const hostile = '记录 ' + '9'.repeat(50_000) + ' 元' + ' '.repeat(50_000) + 'x';
    const started = Date.now();
    parseAmountCents(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('a Chinese amount correction is a correction, not a new expense', () => {
  /**
   * The reason detectCorrection had to learn Chinese in the same change.
   *
   * Before parse-amount.ts knew 元, "其实是 52 元" yielded no amount and the
   * worst case was an unhelpful reply. After it, the message carries a real
   * figure — so if the correction gate still only speaks English, it falls
   * through to classification and books a SECOND expense. That is #416's
   * double-book, reintroduced for Chinese speakers by the parser fix.
   */
  it('detects the correction rather than letting it become a second booking', async () => {
    const { detectCorrection } = await import('../agent-corrections');
    for (const t of ['其实是 52 元', '不对，应该是 88 块', '改成 120 元']) {
      expect(detectCorrection(t), `not detected: ${t}`).toEqual({ kind: 'amount', amountCents: expect.any(Number) });
    }
    expect(detectCorrection('其实是 52 元')).toEqual({ kind: 'amount', amountCents: 5200 });
  });

  it('keeps the guards that stop a fresh instruction being hijacked', async () => {
    const { detectCorrection } = await import('../agent-corrections');
    // A bare cue is session control, a question is a question, and a message
    // about another entity is not a correction of the last expense.
    expect(detectCorrection('不对')).toBeNull();
    expect(detectCorrection('这个可以抵扣吗？')).toBeNull();
    expect(detectCorrection('给客户开一张 500 元的发票')).toBeNull();
  });

  it('does not fire on a plain new expense', async () => {
    const { detectCorrection } = await import('../agent-corrections');
    expect(detectCorrection('记录 42 元咖啡')).toBeNull();
  });
});

describe('the guards are load-bearing, not decoration', () => {
  /**
   * Added after mutation testing: removing the ¥ guard and the
   * Chinese-numeral refusal changed nothing, because every case in the suite
   * above already returned null for an unrelated reason. A guard no test can
   * distinguish is a guard nobody can safely delete.
   */
  it('the foreign-currency guard is what rejects a mixed-currency message', () => {
    // Without it the parser happily books the 20 and ignores the ¥100 —
    // a number from the sentence, in the wrong currency context.
    expect(cents('花了 ¥100，另外 20 元小费')).toBeNull();
  });

  it('the numeral refusal is what stops an unrelated decimal being grabbed', () => {
    // 四十二元 is the real amount and unreadable; 3.50 is a different number
    // in the same sentence. Booking 3.50 would be worse than asking.
    expect(cents('记录 四十二元 咖啡 3.50')).toBeNull();
  });

  it('declines rather than guessing when a counter follows the number', () => {
    // Both decline, and that is the intended trade. 人 also prefixes 人工费
    // (labour), so this costs a convenience — 花了100元人工费 books fine.
    // Narrowing it with a lookahead was tried and made 人份 ("3 servings")
    // book 3 as three dollars, which is the failure this module exists to
    // avoid: asking beats inventing.
    expect(cents('花了 100 人工费')).toBeNull();
    expect(cents('买了 3 人份')).toBeNull();
  });
});

describe('there is one parser', () => {
  /**
   * server.ts ran the same four-regex chain twice — once on the regex-routing
   * path, once on the LLM path — so the Chinese fix would have landed on one
   * and not the other. agent-money-format.test.ts records the identical
   * lesson for the two formatters: "two copies of one rule is exactly what
   * rots". This fails if a third copy grows back.
   */
  it('server.ts extracts amounts only via parseAmountCents', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../server.ts'), 'utf8');

    // The signature of the old chain: a money regex feeding amountCents.
    const inlineChain = /(?:dollars\|bucks\|cad\|usd)/g;
    expect(
      src.match(inlineChain) ?? [],
      'an inline money regex is back in server.ts — extend parse-amount.ts instead',
    ).toEqual([]);

    expect(src).toContain('parseAmountCents');
  });
});

describe('the correction gate runs in linear time (js/polynomial-redos)', () => {
  /**
   * Fifth occurrence of one shape in this codebase: `\s*` … optional … `\s*$`,
   * after period-parse.ts, client-name.ts, consultation-triage.ts twice. I
   * wrote it again here — in the same session as one of those fixes — and
   * CodeQL caught two new alerts in agent-corrections.ts.
   *
   * Chasing them found a THIRD, pre-existing and live: the English BARE_CUE
   * took 2547ms on "ok" + 40k spaces + "x". CodeQL gates only NEW alerts, so
   * it had never surfaced.
   *
   * Every case below times the FAILING match. A match that succeeds returns
   * immediately and proves nothing — the trailing character must be one the
   * class cannot consume, or this test is decoration. That mistake is exactly
   * why the parser's own ReDoS test passed while these three were quadratic.
   */
  it.each([
    ['bare English cue', 'ok'],
    ['bare Chinese cue', '不对'],
    ['Chinese question particle', '这个可以抵扣吗'],
    ['Chinese amount correction', '其实是 52 元'],
  ])('%s: a long trailing run does not blow up', async (_label, prefix) => {
    const { detectCorrection } = await import('../agent-corrections');
    const hostile = prefix + ' '.repeat(200_000) + 'x';
    const started = Date.now();
    detectCorrection(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
