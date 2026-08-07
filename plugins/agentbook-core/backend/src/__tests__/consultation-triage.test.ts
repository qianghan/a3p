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

describe('ambiguity stays with the skill layer', () => {
  // This block asserted the opposite until the existing suite corrected me.
  // I had reasoned that booking a wrong expense is worse than wasting a turn,
  // so ambiguity should divert to the advisor. That was faulty: the skill
  // layer does not book blindly — it gates destructive actions behind
  // confirmation, previews low-confidence intents, has its own clarify path,
  // and scores 97.5%. Diverting ambiguous input replaced a well-tested
  // classifier with a regex file, and four established tests failed at once.
  it('an unrecognised sentence keeps its existing route', () => {
    expect(kind('I have been wondering about the whole superannuation situation lately'))
      .toBe('transactional');
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
    // "我今年需要交多少税" ("how much tax do I owe this year?") is a question
    // about THEIR OWN tax — the skill layer answers that from the ledger, so
    // it belongs there, same as "how much did I spend?".
    expect(kind('我今年需要交多少税')).toBe('transactional');
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

describe('Chinese questions about their own books stay on the skill path', () => {
  /**
   * The English-only DATA_QUESTION list, observed against production.
   *
   * A single character decided whether the user got an answer:
   *
   *   这个月我花了多少钱      → query-expenses → "本月您共花费了 CA$192.00"
   *   这个月我花了多少钱？    → consultation   → "我需要知道你是想看商业支出还是个人支出"
   *
   * Same question. The version WITHOUT the question mark worked, because it
   * fell through every marker list to the transactional default. The version
   * WITH one matched the `[?？]$` catch and was handed to the advisor, which
   * cannot read the ledger. So the more correctly a Chinese speaker punctuates,
   * the worse the product behaves — and every list above the catch was English,
   * so this was true of ALL Chinese data questions, not a few phrasings.
   *
   * These assert the pairs directly, because the defect only shows as a pair.
   */
  it.each([
    '这个月我花了多少钱？',      // how much did I spend this month?
    '谁欠我钱？',                 // who owes me money?
    '我有多少未付发票？',         // how many unpaid invoices do I have?
    '显示我这个月的支出',         // show me this month's expenses
    '我今年的利润是多少？',       // what is my profit this year?
  ])('data question → skill layer: %s', (t) => expect(kind(t)).toBe('transactional'));

  it('the question mark must not decide it', () => {
    // The pair from production. Before the fix these disagreed.
    expect(kind('这个月我花了多少钱')).toBe('transactional');
    expect(kind('这个月我花了多少钱？')).toBe('transactional');
  });

  it('still sends genuine Chinese advice questions to the advisor', () => {
    // The other half. A ledger noun in the sentence must not drag a rules
    // question onto the skill path — the Chinese mirror of "am I eligible for
    // the small business deduction", which contains "deduction".
    expect(kind('我可以抵扣家庭办公室吗？')).toBe('consultative');  // can I deduct a home office?
    expect(kind('我应该预留多少税款？')).toBe('consultative');       // how much tax should I set aside?
    expect(kind('今年的税率是多少？')).toBe('consultative');         // what is this year's tax rate?
    expect(kind('自雇人士有什么规定？')).toBe('consultative');       // what are the rules for the self-employed?
  });

  it('a bare Chinese follow-up stays in the data thread', () => {
    // The mirror of "and meals?". 那餐饮呢？ ends in 呢, so the particle check
    // would otherwise claim it — and the thread would change destination
    // mid-conversation: turn one from the ledger, turn two from the advisor.
    expect(kind('那餐饮呢？')).toBe('transactional');
    expect(kind('那上个月呢？')).toBe('transactional');
    // Still short-only: a full sentence ending in 呢 is not a follow-up.
    expect(kind('我不确定这些新的报税规定到底是怎么回事呢')).toBe('consultative');
  });

  it('distinguishes 花了 (spent) from 应该 (should), like the English pair', () => {
    expect(kind('我这个月花了多少钱？')).toBe('transactional');
    expect(kind('我这个月应该花多少钱？')).toBe('consultative');
  });
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

describe('triage runs in linear time (js/polynomial-redos)', () => {
  // The Chinese particle check was /[吗呢吧]\s*[?？]?\s*$/. Two `\s*` against
  // an `$` anchor is quadratic when the trailing run does not satisfy the
  // anchor: 10k spaces 159ms, 20k 650ms, 40k 2.5s. The input is a chat message.
  //
  // Third occurrence of this exact shape in the codebase, after /[?.!]+$/ in
  // period-parse.ts and again in client-name.ts — which is why it is a scan
  // now and why this test exists rather than a resolution to be careful.
  it('a long trailing run does not blow up the particle check', () => {
    const hostile = '吗' + ' '.repeat(200_000) + 'x';
    const started = Date.now();
    triageTurn(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the Chinese follow-up rule does not reintroduce it', () => {
    // Same shape, one line later: `呢\s*[？?]?\s*$` was the first draft of the
    // bare-follow-up pattern. Timing the FAILING match, not a succeeding one —
    // a match that succeeds is fast and proves nothing.
    const hostile = '那餐饮呢' + ' '.repeat(200_000) + 'x';
    const started = Date.now();
    triageTurn(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still detects the particle it is there to detect', () => {
    expect(kind('这个可以抵扣吗')).toBe('consultative');
    expect(kind('这个可以抵扣吗？')).toBe('consultative');
  });
});
