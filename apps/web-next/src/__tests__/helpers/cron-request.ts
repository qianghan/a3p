import { NextRequest } from 'next/server';

/**
 * Cron routes authenticate fail-closed (see lib/cron-auth.ts), so a test that
 * wants to reach the handler has to authenticate the way a real invocation
 * does. Before the fix these tests reached it BECAUSE the guard was fail-open
 * and CRON_SECRET was unset in the test env — they were passing on the
 * strength of the defect they were meant to be unrelated to.
 *
 * Six files needed this; six hand-rolled copies of the same two lines is
 * exactly what rots, so it lives here.
 */
export const CRON_TEST_SECRET = 'test-secret';

/** Set the secret for a suite. Call in beforeEach. */
export function setCronSecret(secret = CRON_TEST_SECRET): void {
  process.env.CRON_SECRET = secret;
}

export function clearCronSecret(): void {
  delete process.env.CRON_SECRET;
}

/** An authenticated request, as Vercel sends it for a cron invocation. */
export function cronRequest(url: string, secret = CRON_TEST_SECRET): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${secret}` } });
}

/** An UNauthenticated request — for asserting the guard actually refuses. */
export function unauthenticatedCronRequest(url: string): NextRequest {
  return new NextRequest(url);
}
