import { test, expect } from '@playwright/test';

/**
 * GTM regression: the destructive-skill confirm-gate must work on the web
 * chat surface, not just Telegram. Closes G-012 — the third and final
 * rubric auto-fail clause from the 2026-05-21 gap report.
 *
 * Gated on RUN_E2E_CHAT because it requires a live backend with seeded
 * Maya data plus the agentbook-core plugin bundle in place. The unit
 * tests on PlanPreview cover the component-level invariants regardless.
 */
test.describe('GTM — web chat confirm flow', () => {
  test.skip(
    !process.env.RUN_E2E_CHAT,
    'requires RUN_E2E_CHAT=1 — needs running backend + Maya logged in',
  );

  test('destructive skill shows plan preview, then executes on Proceed', async ({ page }) => {
    // Login as Maya.
    await page.goto('/login');
    await page.fill('input[name="email"]', 'maya@agentbook.test');
    await page.fill('input[name="password"]', 'agentbook123');
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|home|agentbook)/);

    // Chat is the default route for the plugin.
    await page.goto('/agentbook/chat');
    await expect(page.locator('text=Hi')).toBeVisible({ timeout: 5000 });

    // Type a destructive request.
    await page.fill('textarea[name="message"]', 'send the latest draft invoice to acme');
    await page.click('button:has-text("Send")');

    // Expect a plan preview to appear.
    await expect(page.locator('text=/I.d like to do this/i')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Proceed")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();

    // Click Proceed — the plan should execute and the preview should clear.
    await page.click('button:has-text("Proceed")');
    // After confirm, a new agent message should arrive that is NOT another
    // plan preview (i.e. an execution result).
    await expect(page.locator('text=/I.d like to do this/i')).toHaveCount(1, {
      timeout: 10000,
    });
  });
});
