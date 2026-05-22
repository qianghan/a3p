/**
 * Resolve the AgentBook tenant ID for an inbound request.
 *
 * Authentication priority:
 *  1. Cron / service-to-service: CRON_SECRET bearer token OR x-vercel-cron header.
 *     Caller MUST also send x-tenant-id (the target tenant for this cron invocation).
 *  2. User session: naap_auth_token cookie → validateSession → user.id.
 *
 * Throws `Response` on no-auth (401) or no-tenant (400). Callers may try/catch
 * to return the Response cleanly; otherwise Next.js returns 500 (which is still
 * safer than the previous behavior of falling back to the 'default' tenant).
 *
 * Note: tenantId is currently equal to user.id (single-tenant model).
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

function safeBearerCompare(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const want = `Bearer ${expected}`;
  if (provided.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(want));
}

function safeSecretCompare(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function isCronAuthenticated(request: NextRequest): boolean {
  // CRON_SECRET is required for any cron path. The `x-vercel-cron: 1`
  // header alone is NOT trusted — Vercel itself strips it from inbound
  // user requests on its platform, but the app also runs outside Vercel
  // (the standalone plugin servers, local dev, container deploys), where
  // any caller can spoof the header. We require the bearer (or
  // ?secret= query param) regardless. See review finding F-6a.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  // Bearer in Authorization header — preferred for Vercel crons.
  if (safeBearerCompare(request.headers.get('authorization'), cronSecret)) {
    return true;
  }

  // Legacy ?secret=... query param — kept for back-compat with the few
  // cron entries that pre-date the bearer convention. Timing-safe.
  try {
    const url = new URL(request.url);
    if (safeSecretCompare(url.searchParams.get('secret'), cronSecret)) return true;
  } catch {
    /* ignore */
  }

  return false;
}

export async function resolveAgentbookTenant(request: NextRequest): Promise<string> {
  // 1. Cron / service path
  if (isCronAuthenticated(request)) {
    const tenantId = request.headers.get('x-tenant-id');
    if (!tenantId) {
      throw new Response(JSON.stringify({ error: 'cron request must specify x-tenant-id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return tenantId;
  }

  // 2. User session
  const authToken = request.cookies.get('naap_auth_token')?.value;
  if (!authToken) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { validateSession } = await import('@/lib/api/auth');
    const user = await validateSession(authToken);
    if (!user?.id) {
      throw new Response(JSON.stringify({ error: 'invalid session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return user.id;
  } catch (err) {
    if (err instanceof Response) throw err;
    throw new Response(JSON.stringify({ error: 'session validation failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Result of safeResolveAgentbookTenant — either a tenantId (authed) or a
 * Response the caller must return immediately (unauthed / forbidden).
 */
export type ResolveResult = { tenantId: string } | { response: NextResponse };

/**
 * Convenience wrapper for route handlers that want graceful 401/400 responses
 * instead of unhandled throws. Returns either { tenantId } or { response } that
 * the handler should immediately return.
 *
 * The `response` is a `NextResponse` so it satisfies both `Response` and
 * `NextResponse` return types in route handlers.
 */
export async function safeResolveAgentbookTenant(
  request: NextRequest
): Promise<ResolveResult> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    return { tenantId };
  } catch (err) {
    if (err instanceof Response) {
      // Re-wrap as NextResponse so the caller's typed return signature accepts it.
      const body = await err.text();
      return {
        response: new NextResponse(body, {
          status: err.status,
          headers: err.headers,
        }),
      };
    }
    return {
      response: NextResponse.json(
        { error: 'internal error during auth' },
        { status: 500 },
      ),
    };
  }
}
