/**
 * Phase 4 e2e — CPA handoff on the deployed app.
 *
 * As Maya: create a review link and run an AI review. Then, in a SECOND
 * unauthenticated browser context, open the public token endpoint, post a
 * comment, and approve the books — proving the accountant flow needs no
 * AgentBook account.
 */

import { test, expect, chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}
async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

test('CPA link + AI review + unauthenticated accountant review', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Owner creates a review link.
  const link = await apiPost(page, '/api/v1/agentbook-cpa/link', { label: 'E2E CPA' });
  expect(link.status, JSON.stringify(link.data)).toBe(201);
  const token = link.data.data.token as string;
  expect(token).toBeTruthy();

  // Owner runs the AI review.
  const review = await apiPost(page, '/api/v1/agentbook-cpa/review', {});
  expect(review.status).toBe(200);
  expect(typeof review.data.data.score).toBe('number');
  expect(Array.isArray(review.data.data.findings)).toBe(true);

  // --- Accountant side: fresh, unauthenticated browser context ---
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE });
  const guest = await ctx.newPage();
  try {
    const pub = await apiGet(guest, `/api/v1/agentbook-cpa/public/${token}`);
    expect(pub.status, JSON.stringify(pub.data)).toBe(200);
    expect(pub.data.data.pnl).toBeTruthy();
    expect(pub.data.data.review).toBeTruthy();

    const comment = await apiPost(guest, `/api/v1/agentbook-cpa/public/${token}/comment`, {
      body: 'Looks good — categorize the two stragglers.', authorName: 'E2E CPA',
    });
    expect(comment.status).toBe(201);

    const signoff = await apiPost(guest, `/api/v1/agentbook-cpa/public/${token}/signoff`, { cpaName: 'E2E CPA' });
    expect(signoff.status).toBe(201);

    // The public view now reflects the comment + sign-off.
    const after = await apiGet(guest, `/api/v1/agentbook-cpa/public/${token}`);
    expect(after.data.data.comments.length).toBeGreaterThanOrEqual(1);
    expect(after.data.data.signoff).toBeTruthy();
  } finally {
    await browser.close();
  }
});
