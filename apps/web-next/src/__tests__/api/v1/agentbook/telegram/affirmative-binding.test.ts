import { describe, it, expect } from 'vitest';
import { lastBotMessageIsAboutExpense } from '@/lib/agentbook-affirmative';

/**
 * A bare "yes" answers THE QUESTION THE BOT JUST ASKED.
 *
 * Reported transcript:
 *
 *   user  给我介绍一下今年报税的新规定   (tell me this year's new tax rules)
 *   bot   你是指哪一个国家或地区的报税规定呢？
 *   user  澳大利亚                      (Australia)
 *   bot   Are you asking about Australian tax forms or something else?
 *   user  是的                          (yes)
 *   bot   I can't book this without a category. Tell me one ("Fuel", …)
 *
 * The affirmative was bound to an expense draft that had been in flight since
 * some earlier session, because the fast path read
 * `ctx.active && CONFIRM_KEYWORDS.test(text)` and nothing else. The English
 * "yes" hits that path directly; "是的" missed the English-only regex and
 * reached the LLM, which had been given the same flawed rule in its prompt.
 *
 * Topic allow-listing was the obvious fix and the wrong one: the vocabulary is
 * open-ended ('daily_briefing', 'review_queue', 'invoices', …) and any list
 * rots the first time someone adds a topic. This asks the narrower question
 * the affirmative is actually answering — was the bot's last message about
 * this expense?
 */
const draft = {
  id: 'exp-1',
  amountCents: 8900,
  currency: 'USD',
  date: new Date(),
  description: 'office supplies',
  vendorName: 'Staples',
  vendorId: 'v-1',
  categoryId: null,
  categoryName: null,
  isPersonal: false,
  status: 'pending_review',
};

describe('an affirmative only confirms when the bot was talking about the expense', () => {
  it('the reported failure: a tax question is not an expense confirmation', () => {
    expect(
      lastBotMessageIsAboutExpense(
        'Are you asking about Australian tax forms or something else related to Australia?',
        draft,
      ),
    ).toBe(false);
  });

  it('a daily briefing is not an expense confirmation', () => {
    expect(
      lastBotMessageIsAboutExpense('Good morning. Your BAS is due in 11 days.', draft),
    ).toBe(false);
  });

  it('a clarifying question about jurisdiction is not one either', () => {
    expect(
      lastBotMessageIsAboutExpense('你是指哪一个国家或地区的报税规定呢？', draft),
    ).toBe(false);
  });
});

describe('the normal receipt flow still confirms', () => {
  // The risk of this guard is breaking the main path it sits on. These pin it.
  it('recognises the draft echoed back with its amount', () => {
    expect(
      lastBotMessageIsAboutExpense('Recorded: $89.00 — office supplies at Staples. Confirm?', draft),
    ).toBe(true);
  });

  it('recognises a whole-dollar rendering', () => {
    expect(lastBotMessageIsAboutExpense('Book this $89 expense?', draft)).toBe(true);
  });

  it('recognises the vendor', () => {
    expect(lastBotMessageIsAboutExpense('Is the Staples one business or personal?', draft)).toBe(true);
  });

  it('recognises a category prompt', () => {
    expect(
      lastBotMessageIsAboutExpense('Which category should I use for this receipt?', draft),
    ).toBe(true);
  });

  it('an unknown last message behaves as before — the check only removes wrong confirms', () => {
    expect(lastBotMessageIsAboutExpense(null, draft)).toBe(true);
    expect(lastBotMessageIsAboutExpense(undefined, draft)).toBe(true);
  });
});

describe('each signal works on its own', () => {
  // Mutation testing caught these missing. Every "normal flow" case above
  // happens to contain an expense keyword too, so deleting the amount, vendor
  // and description matching entirely left all nine tests green — the code was
  // there and nothing exercised it.
  it('the amount alone is enough, with no expense vocabulary', () => {
    expect(lastBotMessageIsAboutExpense('Got it — $89.00 from Tuesday. Shall I go ahead?', draft))
      .toBe(true);
  });

  it('the vendor alone is enough', () => {
    expect(lastBotMessageIsAboutExpense('That Staples one from Tuesday — all good?', draft))
      .toBe(true);
  });

  it('the description alone is enough', () => {
    expect(lastBotMessageIsAboutExpense('The office supplies from Tuesday — shall I?', draft))
      .toBe(true);
  });

  it('none of them, and no expense vocabulary, is not enough', () => {
    expect(lastBotMessageIsAboutExpense('Shall I go ahead?', draft)).toBe(false);
  });
});

describe('no active expense is never a confirmation', () => {
  it('returns false regardless of what was said', () => {
    expect(lastBotMessageIsAboutExpense('Recorded: $89.00. Confirm?', null)).toBe(false);
    expect(lastBotMessageIsAboutExpense(null, undefined)).toBe(false);
  });
});
