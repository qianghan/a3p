/**
 * How much money is in this message?
 *
 * One parser, because there were two. server.ts ran the same four-regex chain
 * on the regex-routing path and again on the LLM path, so a fix to either left
 * the other broken — the exact rot agent-money-format.test.ts documents for
 * the formatters.
 *
 * It was also English-only. "记录 42 元咖啡" matched none of `$X`, an English
 * verb, or dollars/bucks/cad/usd, so a Chinese speaker was told "I couldn't
 * find the amount" about a message that plainly had one, on a product whose
 * routing and replies are otherwise fully Chinese.
 *
 * The rule throughout: never return a number this module had to guess at.
 * A null makes the agent ask; a wrong figure lands in someone's ledger.
 */

/**
 * Chinese full-width digits (０-９) that a Chinese IME emits.
 *
 * The offset is 0xFEE0: U+FF10 (65296) − 0xFEE0 = 48, ASCII '0'. Written as
 * 0xFEF0 first, which maps ４ to '$' — a full-width amount would then have
 * been read by the `$X` rule as a completely different number.
 */
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
}

/**
 * Currencies that are NOT the tenant's.
 *
 * Every supported tenant books in USD, CAD or AUD. ¥ is CNY (or JPY), so
 * reading ¥100 as 100 of their currency is a silent FX error rather than a
 * parse — the class of bug this codebase has shipped before. Bail out
 * entirely rather than match some other number in the same sentence.
 */
const FOREIGN_CURRENCY = /[¥￥]|人民币|\bRMB\b|\bCNY\b|\bJPY\b/i;

/**
 * Chinese numerals. Recognised only so they can be REFUSED.
 *
 * 四十二元 is 42, but a half-implemented numeral reader yields 4 or 10, and
 * this module must not produce a figure it is unsure of. 万 and 千 are absent
 * on purpose — they are multipliers this module does handle, below.
 */
const CHINESE_NUMERAL = /[一二三四五六七八九十百亿兩两零壹贰叁肆伍陆柒捌玖拾佰仟]/;

/**
 * Units that mean the number is a quantity, not money.
 *
 * Deliberately broad. `人` also prefixes 人民币 and 人工费, so "花了 100 人工费"
 * (labour) finds no amount here and the agent asks — the user writes
 * 花了100元人工费 and it books. Narrowing it with a lookahead was tried and
 * broke 人份 ("3 servings"), which then booked 3 as three dollars. Given the
 * choice between asking a question and inventing a figure, this module asks:
 * the bare-number-after-a-verb rule is a convenience, and 元/块 is the signal
 * that actually means money.
 */
const NON_MONEY_UNIT = /^\s*(?:小时|小時|分钟|分鐘|天|日|个|個|次|人|公里|千米|米|年|月|周|週|杯|件|台|张|張|份)/;

/** Chinese words for the currency unit itself. */
const ZH_UNIT = '(?:元|块钱|块|塊錢|塊|圆|圓)';
/** Verbs of spending, the Chinese counterpart of spent|paid|bought. */
const ZH_VERB = '(?:记录|記錄|花费|花費|花了|付了|支付|买了|買了|消费|消費|付)';

/** A number with optional thousands separators and decimals. */
const NUM = '(\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';

function toCents(raw: string, multiplier = 1): number {
  return Math.round(parseFloat(raw.replace(/,/g, '')) * multiplier * 100);
}

/**
 * The amount in cents, or null when there isn't one we can stand behind.
 *
 * Order matters: an explicit currency marker beats a bare number, so that
 * "花了 3 小时" (three hours) never becomes three dollars.
 */
export function parseAmountCents(input: string): number | null {
  const text = normalizeDigits(input ?? '');
  if (!text) return null;

  // Foreign currency anywhere in the message disqualifies the whole message.
  // Picking a different number out of it would be worse than asking.
  if (FOREIGN_CURRENCY.test(text)) return null;

  // 1. $X — the strongest signal, unchanged from the original chain.
  const dollar = text.match(new RegExp(`\\$\\s*${NUM}`));
  if (dollar) return toCents(dollar[1]);

  // 2. Chinese amount with a unit: 42元, 1万元, 1.5万块.
  //    The multiplier is matched WITH the number, never optionally skipped —
  //    reading 1万元 as 1 is a ten-thousand-fold error, silently, in a ledger.
  const zhUnit = text.match(new RegExp(`${NUM}\\s*(万|萬|千)?\\s*${ZH_UNIT}`));
  if (zhUnit) {
    const mult = zhUnit[2] === '千' ? 1000 : zhUnit[2] ? 10000 : 1;
    return toCents(zhUnit[1], mult);
  }

  // A numeral we cannot read, sitting against a currency unit, means the
  // message HAS an amount and we failed to parse it. Falling through to a
  // looser rule here is how you book an unrelated number from the sentence.
  if (CHINESE_NUMERAL.test(text) && new RegExp(ZH_UNIT).test(text)) return null;

  // 3. English verb then a bare number: "spent 42 on lunch".
  const enVerb = text.match(
    new RegExp(`(?:spent|paid|bought|purchased|cost|was)\\s+\\$?${NUM}`, 'i'),
  );
  if (enVerb) return toCents(enVerb[1]);

  // 4. Chinese verb then a bare number, with the quantity guard: 花了 42.
  const zhVerb = text.match(new RegExp(`${ZH_VERB}\\s*${NUM}\\s*(万|萬|千)?`));
  if (zhVerb) {
    const after = text.slice(zhVerb.index! + zhVerb[0].length);
    if (!NON_MONEY_UNIT.test(after)) {
      const mult = zhVerb[2] === '千' ? 1000 : zhVerb[2] ? 10000 : 1;
      return toCents(zhVerb[1], mult);
    }
  }

  // 5. Trailing currency words.
  const word = text.match(new RegExp(`${NUM}\\s*(?:dollars|bucks|cad|usd|aud)\\b`, 'i'));
  if (word) return toCents(word[1]);

  // 6. Last resort: a standalone decimal, which reads as money on its own.
  const bare = text.match(/\b(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\b/);
  if (bare) return toCents(bare[1]);

  return null;
}
