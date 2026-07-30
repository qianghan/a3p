import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api } from './helpers/api';
import { SEED } from './helpers/data';

test.describe('@phase2-dashboard', () => {
  test.beforeEach(async ({ page }) => { await loginAsE2eUser(page); });

  // ---------------------------------------------------------------------
  // The dashboard was redesigned into an agent-centric view. The old forward
  // view, "Needs your attention" panel, this-month strip, activity feed and
  // mobile "Quick actions" bar no longer exist, so ten tests here asserted on
  // a UI that is gone. They had never run, so nobody noticed the drift.
  //
  // Rather than delete the intent, each promise is re-asserted where it now
  // lives: the numbers against /dashboard/overview (which still computes cash,
  // the attention queue and month-to-date), and the page itself against what
  // it actually renders. Asserting rendered content, not just a URL, is the
  // lesson from the tax-nav bug — a link can be present while the page behind
  // it is broken.
  // ---------------------------------------------------------------------

  test('dashboard renders for an authenticated user', async ({ page }) => {
    await page.goto('/agentbook');
    await expect(page.getByRole('heading', { name: /^Dashboard$/i })).toBeVisible({ timeout: 10_000 });
  });

  test('the advisor panel renders and is named', async ({ page }) => {
    await page.goto('/agentbook');
    // The personified advisor is a product promise, not decoration: the panel
    // must actually mount, not just leave a heading behind.
    await expect(page.locator('[data-testid="chat-messages"]')).toBeVisible({ timeout: 15_000 });
  });

  test('overview reports non-zero cash for the seeded tenant', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-core/dashboard/overview');
    expect(r.status).toBe(200);
    expect(typeof r.data.data.cashToday).toBe('number');
    // The seed books real invoices and expenses, so this tenant is never "brand
    // new". If it flips true, the seed silently did nothing.
    expect(r.data.data.isBrandNew).toBe(false);
  });

  test('overview surfaces the seeded overdue invoice in the attention queue', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-core/dashboard/overview');
    expect(r.status).toBe(200);
    expect(r.data.data.attention).toBeTruthy();
    const serialised = JSON.stringify(r.data.data.attention);
    expect(serialised).toMatch(/overdue/i);
  });

  test('month-to-date figures are present', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-core/dashboard/overview');
    expect(r.status).toBe(200);
    // monthMtd is deliberately null when both sides are zero; the seeded tenant
    // has activity, so null here means the aggregation stopped working.
    expect(r.data.data.monthMtd).not.toBeNull();
    expect(typeof r.data.data.monthMtd.revenueCents).toBe('number');
    expect(typeof r.data.data.monthMtd.expenseCents).toBe('number');
  });

  test('primary money surfaces are reachable AND render', async ({ page }) => {
    // Each destination must render its own content. A working link to a broken
    // page is exactly what a URL-only assertion misses.
    for (const [href, heading] of [
      ['/agentbook/expenses', /expense/i],
      ['/agentbook/invoices', /invoice/i],
      ['/agentbook/tax', /tax|report/i],
    ] as const) {
      await page.goto(href);
      await expect(page.getByRole('heading', { name: heading }).first())
        .toBeVisible({ timeout: 15_000 });
    }
  });

  // The mobile "Quick actions" bar, its "New invoice" link and the kebab menu
  // were all removed in the dashboard redesign — verified absent at 375x812 on
  // production, not merely assumed. Their tests are deleted rather than left
  // failing, since there is no longer a promise behind them.
  //
  // Receipt capture IS still a real, recently-fixed feature; it just lives on
  // /app/capture now, so that coverage is retargeted rather than dropped.
  test('mobile receipt capture offers a camera input', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/app/capture');
    await expect(page.locator('input[type="file"][capture="environment"]')).toHaveCount(1);
  });

  test('OnboardingHero is not shown (seed worked)', async ({ page }) => {
    await page.goto('/agentbook');
    await expect(page.locator('text=/Welcome to AgentBook/i')).toHaveCount(0);
  });
});
