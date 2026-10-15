import { test, expect, type Page } from '@playwright/test';
import { MOBILE_VIEWPORT, catalogT, loginAs, pageLocales, settle } from './helpers';

/**
 * Replays a short transcript through the MOBILE UI against production right
 * after a deploy. Catches consultation-reviewer regressions: a rule written for
 * one caller firing on another caller's legitimate replies ("hello" -> safe-
 * fallback boilerplate, #565). Content assertions only; no fixed turn counts.
 * Server replies are matched through the server's own catalog keys, not English literals.
 */
const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.skip(!/agentbook\.brainliber\.com/.test(BASE), 'prod-only replay');
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block' });

const SAFE_FALLBACK = /I don't want to quote you a number/i;
const BROKEN = /something went wrong|agent brain failed|^Error: /im;

async function sendAndRead(page: Page, text: string) {
  const bots = page.getByTestId('chat-bubble-bot');
  const before = await bots.count();
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
  await expect(bots).toHaveCount(before + 1, { timeout: 90_000 });
  // By index, not `.last()`: a locator is lazy and would drift to a later bubble.
  return bots.nth(before);
}

test('mobile transcript replay - no reviewer-rule regressions', async ({ page }) => {
  await loginAs(page, 'maya');
  await settle(page);
  // Land on the chat FIRST: the string locale is the document's lang, only the tenant's once an /app page loaded,
  // and "history loading is gone" is trivially true before the screen has hydrated (it counted 0 bubbles, then 5).
  await page.goto('/app/chat');
  await expect(page.getByTestId('chat-screen')).toBeVisible();
  await expect(page.getByTestId('chat-history-loading')).toHaveCount(0, { timeout: 30_000 });
  const t = catalogT((await pageLocales(page)).stringLocale);
  await expect(page.getByRole('heading', { level: 1 }), 'catalog locale does not match the rendered page').toHaveText(t('mobile.chat.title'));
  const transcript: Array<{ text: string; must?: RegExp; noPlan?: boolean }> = [
    { text: 'hello', noPlan: true },
    // "cancel" with no plan pending: the server's truthful reply, or an already-cancelled notice.
    { text: 'cancel' },
    { text: 'Give me more details' },
    // Any currency symbol / digit: the persona's currency and locale decide the format.
    { text: 'how much did I spend this month?', must: /\d/ },
  ];
  for (const turn of transcript) {
    const reply = await sendAndRead(page, turn.text);
    const text = (await reply.textContent()) ?? '';
    expect(text.trim().length, `"${turn.text}" got an empty reply`).toBeGreaterThan(0);
    expect(text, `"${turn.text}" hit the reviewer safe-fallback`).not.toMatch(SAFE_FALLBACK);
    expect(text, `"${turn.text}" surfaced an error`).not.toMatch(BROKEN);
    expect(text, `"${turn.text}" hit the client error bubble`).not.toContain(t('mobile.chat.action_failed'));
    if (turn.must) expect(text, `"${turn.text}"`).toMatch(turn.must);
    if (turn.noPlan) await expect(reply.getByTestId('chat-plan-card')).toHaveCount(0);
  }
});
