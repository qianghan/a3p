import { test, expect, type Page } from '@playwright/test';
import { MOBILE_VIEWPORT, catalogT, loginAs, newPersonaContext, pageLocales, settle, type CatalogT } from './helpers';
import { inPageFetch } from './page-api';
import { PERSONA_CURRENCY, createExpense, deleteExpenseQuietly, randomWholeDollars, runTag, todayIso } from './fixtures';

/**
 * Chat journeys on a DEPLOYED site (PR 6). Every UI string is read from the app's own catalog (the persona may
 * render fr-CA / zh-CN); server reply text is only ever asserted through the server's catalog keys, never English.
 *
 * Cleanup: plans are CANCELLED or run as a no-op edit (nothing booked); the one journey that books (photo) deletes
 * what it created in a `finally` and sweeps its run tag again in afterAll.
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const MSG = '**/api/v1/agentbook-core/agent/message';
const MSG_PATH = '/api/v1/agentbook-core/agent/message';
// The reviewer's safe-fallback boilerplate (server text, English-only by design: it is the regression signature).
const SAFE_FALLBACK = /I don't want to quote you a number/i;

async function tFor(page: Page): Promise<CatalogT> {
  // The string locale comes from the document's lang, which is only the tenant's once an /app page has loaded;
  // read it earlier and `t` silently falls back to English, so every "not.toContainText(<server text>)" check
  // passes for the wrong reason. So: load the chat, read the locale, then PROVE `t` matches what is on screen.
  await page.goto('/app/chat');
  await expect(page.getByTestId('chat-screen')).toBeVisible();
  const t = catalogT((await pageLocales(page)).stringLocale);
  await expect(page.getByRole('heading', { level: 1 }), 'catalog locale does not match the rendered page').toHaveText(t('mobile.chat.title'));
  return t;
}
async function openChat(page: Page) {
  await page.goto('/app/chat');
  await expect(page.getByTestId('chat-screen')).toBeVisible();
  await expect(page.getByTestId('chat-history-loading')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('chat-history-error')).toHaveCount(0);
}
const bots = (page: Page) => page.getByTestId('chat-bubble-bot');
async function send(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}
async function nextBot(page: Page, before: number) {
  await expect(bots(page)).toHaveCount(before + 1, { timeout: 90_000 });
  // Pinned by index, not `.last()`: a locator is lazy, and after the NEXT reply `.last()` would point at a different bubble.
  const b = bots(page).nth(before);
  await expect(b).not.toHaveText('');
  return b;
}
/** Drop any stale pending plan so the next "edit my last expense" starts a fresh one. */
async function clearSession(page: Page) {
  await inPageFetch(page, 'POST', MSG_PATH, { sessionAction: 'cancel' });
}

test.describe('mobile chat (Maya)', () => {
  const tag = runTag('E2ECHATMA');
  let t: CatalogT;

  test.afterAll(async ({ browser }) => {
    // Best-effort sweep of anything the photo journey booked under this run's tag, on a fresh context.
    const ctx = await newPersonaContext(browser, process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com');
    try {
      const page = await ctx.newPage();
      await loginAs(page, 'maya');
      const list = await inPageFetch<{ data: Array<{ id: string }> }>(page, 'GET', `/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(tag)}&limit=100`);
      for (const r of list.data?.data ?? []) await inPageFetch(page, 'DELETE', `/api/v1/agentbook-expense/expenses/${r.id}`);
    } catch {
      /* nothing to sweep, or the site is unreachable */
    } finally {
      await ctx.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'maya');
    await settle(page);
    t = await tFor(page);
  });

  test('history loads after a reload, with the bot reply rendered', async ({ page }) => {
    await openChat(page);
    const marker = `e2e-hist-${Date.now()}`;
    const before = await bots(page).count();
    await send(page, `how much did I spend this month? (${marker})`);
    const reply = await nextBot(page, before);
    await expect(reply).not.toContainText(SAFE_FALLBACK);
    // Turns are written right after the reply; poll a few reloads rather than sleeping.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('chat-bubble-user').filter({ hasText: marker })).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    const userBubble = page.getByTestId('chat-bubble-user').filter({ hasText: marker });
    await expect(userBubble).toHaveAttribute('data-status', 'sent');
    // The bot turn after it is in history too (oldest-first ordering).
    const all = page.locator('[data-testid="chat-bubble-user"], [data-testid="chat-bubble-bot"]');
    const texts = await all.allTextContents();
    const idx = texts.findIndex((x) => x.includes(marker));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(texts.length - 1);
  });

  test('a plan renders Proceed/Cancel and Proceed executes', async ({ page }) => {
    // "edit my last expense" really edits the persona's most recent expense, so give it one of OUR OWN (dated today,
    // tagged, deleted below) instead of letting Proceed touch a seeded record.
    const fixtureId = await createExpense(page, {
      amountCents: randomWholeDollars() * 100, vendor: `${tag} Edit`, description: `${tag} edit target`,
      date: todayIso(), currency: PERSONA_CURRENCY.maya, isPersonal: false,
    });
    try {
    await openChat(page);
    await clearSession(page);
    await page.reload();
    await openChat(page);
    let executed = false;
    for (let attempt = 0; attempt < 3 && !executed; attempt++) {
      const before = await bots(page).count();
      await send(page, 'edit my last expense');
      const reply = await nextBot(page, before);
      const card = reply.getByTestId('chat-plan-card');
      if ((await card.count()) === 0) {
        await clearSession(page);
        continue;
      }
      await expect(card.getByTestId('chat-plan-proceed')).toBeVisible();
      await expect(card.getByTestId('chat-plan-cancel')).toBeVisible();
      const n = await bots(page).count();
      await card.getByTestId('chat-plan-proceed').click();
      const result = await nextBot(page, n);
      await expect(result.getByTestId('chat-plan-card')).toHaveCount(0);
      await expect(result).not.toContainText(t('agent.nothing_to_confirm'));
      await expect(result).not.toContainText(t('mobile.chat.action_failed'));
      await expect(card).toHaveAttribute('data-state', 'done');
      await expect(card.getByTestId('chat-plan-proceed')).toHaveCount(0);
      executed = true;
    }
    expect(executed, 'no plan preview appeared within 3 attempts of "edit my last expense"').toBe(true);
    } finally {
      await deleteExpenseQuietly(page, fixtureId);
    }
  });

  test('Cancel on a plan cancels it (nothing is booked)', async ({ page }) => {
    await openChat(page);
    await clearSession(page);
    let cancelled = false;
    for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
      const before = await bots(page).count();
      await send(page, 'edit my last expense');
      const reply = await nextBot(page, before);
      const card = reply.getByTestId('chat-plan-card');
      if ((await card.count()) === 0) { await clearSession(page); continue; }
      const n = await bots(page).count();
      await card.getByTestId('chat-plan-cancel').click();
      const result = await nextBot(page, n);
      await expect(result).not.toContainText(t('agent.nothing_to_cancel'));
      await expect(result).not.toContainText(t('mobile.chat.action_failed'));
      await expect(card).toHaveAttribute('data-state', 'done');
      cancelled = true;
    }
    expect(cancelled, 'no plan preview appeared within 3 attempts of "edit my last expense"').toBe(true);
  });

  test('a suggestion chip sends its text and gets a real reply', async ({ page }) => {
    let canned = true;
    await page.route(MSG, async (route) => {
      if (canned && route.request().method() === 'POST') {
        canned = false;
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { message: 'Here you go.', skillUsed: 'general-question', confidence: 1, suggestions: ['Show my recent expenses'] } }),
        });
      }
      return route.continue();
    });
    await openChat(page);
    const before = await bots(page).count();
    await send(page, 'hello');
    const first = await nextBot(page, before);
    const chip = first.getByTestId('chat-suggestion').filter({ hasText: 'Show my recent expenses' });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByTestId('chat-bubble-user').last()).toContainText('Show my recent expenses');
    const real = await nextBot(page, before + 1);
    await expect(real).not.toContainText(SAFE_FALLBACK);
  });

  test('a failed send keeps the text and Retry delivers it', async ({ page }) => {
    let failNext = true;
    await page.route(MSG, async (route) => {
      if (failNext && route.request().method() === 'POST') { failNext = false; return route.abort('failed'); }
      return route.continue();
    });
    await openChat(page);
    const text = `retry me ${Date.now()}`;
    await send(page, text);
    const mine = page.getByTestId('chat-bubble-user').filter({ hasText: text });
    await expect(mine).toHaveAttribute('data-status', 'failed');
    await expect(mine.getByTestId('chat-retry')).toBeVisible();
    const before = await bots(page).count();
    await mine.getByTestId('chat-retry').click();
    await nextBot(page, before);
    await expect(mine).toHaveAttribute('data-status', 'sent');
    await expect(mine.getByTestId('chat-retry')).toHaveCount(0);
  });

  test('429 shows the server message, disables send, and counts down', async ({ page }) => {
    const serverMessage = 'E2E rate limit notice - try again in a moment.';
    await page.route(MSG, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 429, contentType: 'application/json', headers: { 'Retry-After': '4' },
        body: JSON.stringify({ success: false, error: 'rate_limited', reason: 'minute', retryAfterMs: 4000, message: serverMessage, locale: 'en' }),
      });
    });
    await openChat(page);
    await send(page, 'hi');
    const notice = page.getByTestId('chat-ratelimit');
    await expect(notice).toContainText(serverMessage);
    await expect(notice).toContainText(/\d/); // the live "available in N s" line
    await page.getByTestId('chat-input').fill('again');
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(notice).toBeHidden({ timeout: 8_000 });
    await expect(page.getByTestId('chat-send')).toBeEnabled();
  });

  test('typing indicator shows while a reply is pending', async ({ page }) => {
    await page.route(MSG, async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
      return route.continue();
    });
    await openChat(page);
    const before = await bots(page).count();
    await send(page, 'hello');
    await expect(page.getByTestId('chat-typing')).toBeVisible();
    await nextBot(page, before);
    await expect(page.getByTestId('chat-typing')).toHaveCount(0);
  });

  test('photo attach books a receipt and opens it in the viewer', async ({ page }) => {
    await openChat(page);
    const shot = await page.context().newPage();
    await shot.setContent(`<div id="r" style="width:360px;padding:24px;font:20px monospace;background:#fff;color:#000">E2E COFFEE BAR ${tag}<br>2026-10-07<br>Latte 4.50<br>TOTAL $4.50</div>`);
    const buffer = await shot.locator('#r').screenshot();
    await shot.close();
    // Mobile Chromium: the sheet opens, then the library input takes the file (no real chooser needed).
    await page.getByTestId('chat-attach').click();
    await page.getByTestId('chat-file-library').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer });
    const card = page.getByTestId('chat-receipt').last();
    await expect(card).toHaveAttribute('data-status', 'done', { timeout: 90_000 });
    const href = await card.getByTestId('chat-receipt-open').getAttribute('href');
    expect(href).toMatch(/^\/app\/docs\/[^/]+$/);
    const id = href!.split('/').pop()!;
    try {
      await expect(card).toContainText(
        new RegExp([t('mobile.chat.receipt_saved'), t('mobile.chat.receipt_needs_review'), t('mobile.chat.receipt_duplicate')].map(escapeRe).join('|')),
      );
      await expect(card).toContainText(new RegExp(`4[.,]50|${escapeRe(t('mobile.chat.unreadable_amount'))}`));
      await card.getByTestId('chat-receipt-open').click();
      await page.waitForURL(new RegExp(`/app/docs/${escapeRe(id)}$`), { timeout: 20_000 });
      await expect(page.getByTestId('doc-skeleton')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId('doc-amount')).toBeVisible();
    } finally {
      const del = await inPageFetch(page, 'DELETE', `/api/v1/agentbook-expense/expenses/${id}`);
      expect(del.status, 'cleanup delete of the e2e receipt').toBe(200);
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('mobile chat (fresh account)', () => {
  test('empty state starter chip sends and gets a reply', async ({ page }) => {
    await loginAs(page, 'fresh');
    await settle(page);
    await openChat(page);
    const empty = page.getByTestId('chat-empty');
    await expect(empty).toBeVisible();
    await expect(empty.getByTestId('chat-starter')).toHaveCount(3);
    await empty.getByTestId('chat-starter').first().click();
    await expect(page.getByTestId('chat-bubble-user')).toHaveCount(1);
    await nextBot(page, 0);
  });
});
