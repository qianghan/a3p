import type { Page } from '@playwright/test';

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL || 'e2e@agentbook.test',
  password: process.env.E2E_USER_PASSWORD || 'e2e-nightly-2026',
};

/**
 * Log in as the dedicated nightly e2e user. After this returns, the page
 * has a valid session cookie and is on /dashboard.
 */
export async function loginAsE2eUser(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', E2E_USER.email);
  await page.fill('input[type="password"]', E2E_USER.password);
  await page.click('button[type="submit"]');

  // Match on the PATH, anchored. The previous check was
  // waitForURL(/\/dashboard|\/agentbook/), which also matches
  // "/login?redirect=/dashboard" — exactly the URL you sit on when login
  // FAILS. That made a failed login report success, so the suite looked
  // partly green while no session existed at all.
  // 30s, not 15s. Four workers sign in concurrently against production, and a
  // cold serverless function comfortably exceeds 15s under that load — which
  // showed up as tests failing at ~16.7s and passing on retry. That flakiness
  // is the harness racing a cold start, not the product being broken, and
  // treating it as a product signal wastes exactly the attention this suite
  // exists to direct.
  await page.waitForURL((url) => /^\/(dashboard|agentbook)(\/|$)/.test(url.pathname), {
    timeout: 30_000,
  });

  // Prove the session is real. A URL match alone is not proof: the middleware
  // only checks that an auth cookie is PRESENT (it can't verify a signature at
  // the edge), so a stale or invalid cookie still navigates fine. One
  // authenticated request is the only honest confirmation.
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/v1/agentbook-core/dashboard/overview', {
      credentials: 'include',
    });
    return r.status;
  });
  if (status !== 200) {
    throw new Error(
      `E2E login did not establish a valid session (authenticated probe returned ${status}).\n` +
        'Most likely cause: the E2E_USER_PASSWORD that CI logs in with does not match the ' +
        'value the PRODUCTION server used when it seeded the user via reset-e2e-user ' +
        '(scripts/seed-e2e-user.ts reads its own process.env.E2E_USER_PASSWORD). ' +
        'Check that the GitHub secret and the Vercel production env var hold the same value.',
    );
  }
}

/**
 * Resets the e2e user via the internal endpoint. Returns false if the
 * endpoint is not enabled (no E2E_RESET_TOKEN secret).
 *
 * NOTE: route path is /api/v1/e2e-test/reset-e2e-user — NOT /__test/...
 * because Next.js App Router excludes underscore-prefixed folders from
 * routing.
 */
export async function resetE2eUser(baseURL: string): Promise<boolean> {
  const token = process.env.E2E_RESET_TOKEN;
  if (!token) return false;
  const res = await fetch(`${baseURL}/api/v1/e2e-test/reset-e2e-user`, {
    method: 'POST',
    headers: { 'x-e2e-reset-token': token },
  });
  return res.ok;
}
