import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * One fail-closed gate for every scheduled job.
 *
 * 21 cron routes carried this shape:
 *
 *     if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
 *       return 401;
 *     }
 *
 * An UNSET variable makes the condition false, so nothing returns 401 and the
 * job runs for anybody who finds the URL. They are protected today only
 * because the variable happens to be set — a deploy to an environment that
 * forgot it silently opens all 21, including `recognize-revenue` (revenue
 * recognition), the `*-sync` family (pulls bank data) and
 * `notifications-dispatch` (sends outbound messages).
 *
 * #387 flipped exactly this pattern on six damage-path routes and left the
 * rest as a "consistency follow-up". This is that follow-up.
 *
 * Accepts both shapes already in use — `Authorization: Bearer <secret>` (what
 * Vercel sends automatically for a cron invocation when CRON_SECRET is set)
 * and `?secret=` (four older routes) — so no existing caller changes.
 *
 * Deliberately NOT in scope: four routes additionally treat `x-vercel-cron: 1`
 * as sufficient on its own. That is a forgeable-header problem rather than a
 * fail-open one, and folding it in here would double the regression surface of
 * a security fix. Separate change.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when `provided` is exactly `Bearer <expected>`, compared in constant time. */
export function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  return safeEqual(provided, `Bearer ${expected}`);
}

/**
 * Returns a 401 response to return, or null when the caller is authorised.
 *
 * Fail-closed: a missing or empty CRON_SECRET authorises nobody.
 */
export function requireCronSecret(request: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Loud in logs, opaque to the caller — an attacker learns nothing about
    // why, and an operator who forgot the variable sees it immediately.
    console.error('[cron-auth] CRON_SECRET is not set; refusing the request');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (safeCompareBearer(request.headers.get('authorization'), expected)) return null;

  const query = request.nextUrl.searchParams.get('secret');
  if (query && safeEqual(query, expected)) return null;

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
