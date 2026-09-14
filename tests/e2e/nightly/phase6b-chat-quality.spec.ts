import { test, expect } from '@playwright/test';
import { postUpdate } from './helpers/telegram';

/**
 * The 2026-09-13 prod transcript, replayed. Each assertion names the reply
 * that was wrong that day (docs/superpowers/specs/2026-09-13-chat-quality-review.md).
 */
test.describe('@phase6b-chat-quality', () => {
  test.beforeAll(async () => {
    const probe = await postUpdate('ping');
    test.skip(probe.data?.error === 'Bot not configured' || probe.status === 503, 'bot not configured');
    if (probe.data?.botReply === undefined) throw new Error('E2E_TELEGRAM_CAPTURE is not active on the deployment');
  });

  test('"Expenses" renders without raw markdown and does not list the categories twice', async () => {
    const r = await postUpdate('Expenses');
    expect(r.reply).not.toMatch(/^\*\s{2,}/m);           // F9: literal "*   " bullets
    expect(r.reply).not.toMatch(/(^|\s)_Period:/);        // F9: literal underscores
    expect(r.reply).toMatch(/Period:|Période|期间/i);
    const enumeratesCategories = /categor/i.test(r.reply) && /•/.test(r.reply);
    const hasBreakdownBlock = /Breakdown/.test(r.reply);
    expect(enumeratesCategories && hasBreakdownBlock, 'the answer listed categories AND a Breakdown block repeated them (F9)').toBe(false);
  });

  test('"Categorize them" answers in English with counts that add up', async () => {
    const r = await postUpdate('Categorize them');
    let reply = r.reply;
    if (/proceed|yes\/no/i.test(reply)) { const c = await postUpdate('yes'); reply = c.reply; }
    expect(reply, 'French template on an English question (F5)').not.toMatch(/catégori/i);
    // Either nothing to do, or "Categorized N of M" — never "all categorized" alongside an unplaced list.
    const m = reply.match(/Categorized (\d+) of (\d+)/i);
    if (m) {
      const [applied, total] = [Number(m[1]), Number(m[2])];
      expect(applied).toBeLessThanOrEqual(total);
      if (applied < total) expect(reply, 'claimed completeness with items left (F1)').not.toMatch(/nothing left to categorize/i);
    } else {
      expect(reply).toMatch(/nothing left|already categorized|filed/i);
    }
  });

  test('"Give me more details" continues the previous turn', async () => {
    await postUpdate('What is my cash balance?');
    const r = await postUpdate('Give me more details');
    expect(r.reply, 'lost the thread (F6)').not.toMatch(/more details about what/i);
    // The 2026-09-13 regression, exactly: the reviewer's safeFallback() text.
    // An under-specified follow-up routes to the catch-all bucket, where a
    // short reply that narrows the question is correct — repairing it into
    // "I can look this up against your books, but…" is not.
    expect(r.reply, 'repaired into the safe fallback').not.toMatch(/can't stand behind/i);
    expect(r.reply).toMatch(/cash|balance|receivable|\$/i);
  });

  test('"cancel" with nothing pending is answered plainly', async () => {
    // The phase6 spec runs first on this tenant and can leave a plan awaiting
    // approval (run 34795918547: its correction turn with nothing to correct
    // produced an edit-expense "Proceed?" preview). Cancelling THAT is the
    // correct reply ("Plan cancelled."), so it is not what this test measures.
    // Clear any leftover session first, then assert the nothing-pending line.
    let r = await postUpdate('cancel');
    if (/cancelled|annul|已取消/i.test(r.reply ?? '')) r = await postUpdate('cancel');
    expect(r.reply, 'improvised a question (F7)').not.toMatch(/subscription|invoice, or something else/i);
    // Even once "cancel" is intercepted before the advisor, the fallback
    // behind it must stay sane: on 2026-09-13 this turn came back as the
    // reviewer's safeFallback() text.
    expect(r.reply, 'repaired into the safe fallback').not.toMatch(/can't stand behind/i);
    expect(r.reply).toMatch(/nothing/i);
  });

  test('what-if returns a projection', async () => {
    const r = await postUpdate('what if I hire someone at $5K/mo?');
    expect(r.reply).toMatch(/(?:CA|A|US)?\$\s?[\d,]+|[\d\s]+,\d{2}\s?\$/);
    expect(r.reply).toMatch(/runway|monthly net|net mensuel|piste|跑道|每月净|月度净额/i);
  });
});
