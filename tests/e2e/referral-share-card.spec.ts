/**
 * Referral program — shareable card (OG PNG) + copy/share controls,
 * validated on the deployed app.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const MAYA_EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const MAYA_PW = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', MAYA_EMAIL);
  await page.fill('input[type="password"]', MAYA_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/agentbook|\/dashboard|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);
}

test('unknown referral code -> 404 for the card image', async ({ request }) => {
  const res = await request.get('/api/v1/agentbook-billing/referrals/card/ZZZZ-ZZZZ');
  expect(res.status()).toBe(404);
});

test('card image renders a real PNG for a valid code', async ({ page, request }) => {
  await login(page);
  const me = await page.evaluate(async () =>
    (await (await fetch('/api/v1/agentbook-billing/referrals/me', { credentials: 'include' })).json()).data,
  );
  const res = await request.get(`/api/v1/agentbook-billing/referrals/card/${me.code}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  const body = await res.body();
  expect(body.length).toBeGreaterThan(1000); // a real rendered image, not an empty/error stub
});

test('Referrals tab shows the card image + copy caption + share links', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await page.goto('/settings?tab=agentbook&subtab=referrals');
  await page.waitForTimeout(2_000);

  const img = page.getByAltText('AgentBook referral card');
  await expect(img).toBeVisible({ timeout: 10_000 });
  // Confirm the image actually decoded (not a broken image icon).
  const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);

  await page.getByRole('button', { name: /copy caption/i }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('AgentBook');
  expect(clipboard).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/); // the code is embedded in the caption

  await expect(page.getByRole('link', { name: /download image/i })).toHaveAttribute('href', /\/referrals\/card\//);
  await expect(page.getByRole('link', { name: /share on x/i })).toHaveAttribute('href', /twitter\.com\/intent\/tweet/);
  await expect(page.getByRole('link', { name: /share on linkedin/i })).toHaveAttribute('href', /linkedin\.com/);
  await expect(page.getByRole('link', { name: /share on whatsapp/i })).toHaveAttribute('href', /wa\.me/);
});
