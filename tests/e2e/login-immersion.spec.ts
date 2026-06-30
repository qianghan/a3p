/**
 * Login immersion — the dark canvas must keep the form fully usable.
 * Asserts the wordmark + email/password inputs + submit button render and the
 * inputs accept text (guards against the dark layout breaking the form).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

test('login screen: wordmark + usable form on the dark canvas', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });

  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await expect(email).toBeVisible();
  await expect(password).toBeVisible();
  await email.fill('test@example.com');
  await password.fill('secret123');
  await expect(email).toHaveValue('test@example.com');

  await expect(page.locator('button[type="submit"]')).toBeVisible();
});

test('register screen renders on the dark canvas', async ({ page }) => {
  await page.goto('/register');
  await expect(page.locator('[aria-label="AgentBook"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});
