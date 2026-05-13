/**
 * AgentBook billing — manual e2e.
 *
 * These tests exercise the full admin-clone-template + user-subscribe
 * loop against a running app + Stripe test mode. They are NOT part of
 * the default `npx playwright test` run unless the four env vars below
 * are set, because:
 *   • Stripe API calls cost time and emit real (test-mode) Customers
 *   • The user-subscribe test requires NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
 *     to be injected into the running web app
 *
 * To run locally:
 *   STRIPE_SECRET_KEY=sk_test_... \
 *   STRIPE_WEBHOOK_SECRET=whsec_... \
 *   ADMIN_EMAILS=admin@a3p.io \
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_... \
 *   npx playwright test tests/billing.spec.ts
 *
 * In CI, gate via `test.skip(!process.env.STRIPE_SECRET_KEY, '...')` so
 * the suite passes when Stripe creds are absent.
 */
import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@a3p.io', password: 'a3p-dev' };
const MAYA  = { email: 'maya@agentbook.test', password: 'agentbook123' };

test.describe('billing — admin flow', () => {
  test.skip(!process.env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY not set');

  test('admin can clone the Pro template and save a new plan', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', ADMIN.email);
    await page.fill('input[name="password"]', ADMIN.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|admin/);

    await page.goto('/admin/billing');
    await expect(page.getByRole('heading', { name: /subscription plans/i })).toBeVisible();
    await page.getByRole('button', { name: /new plan from template/i }).click();
    await page.getByText(/^Pro$/).click();
    // Editor opens pre-filled; just save
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Pro').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('billing — user subscribe + gate', () => {
  test.skip(!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY not set');

  test('Maya can upgrade from Free to Pro with the test card', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', MAYA.email);
    await page.fill('input[name="password"]', MAYA.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|agentbook/);

    await page.goto('/billing');
    await expect(page.getByText(/Current plan/i)).toBeVisible();

    await page.getByRole('button', { name: /upgrade/i }).first().click();
    await expect(page.getByText(/Upgrade to/i)).toBeVisible();

    // Stripe Payment Element renders into iframes named __privateStripeFrame*
    const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();
    await stripeFrame.locator('[name="number"]').fill('4242 4242 4242 4242');
    await stripeFrame.locator('[name="expiry"]').fill('12 / 34');
    await stripeFrame.locator('[name="cvc"]').fill('123');
    await stripeFrame.locator('[name="postalCode"]').fill('12345');

    await page.getByRole('button', { name: /subscribe to/i }).click();
    await expect(page.getByText(/Pro/)).toBeVisible({ timeout: 30_000 });
  });
});
