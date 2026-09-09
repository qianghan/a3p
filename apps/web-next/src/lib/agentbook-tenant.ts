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
 * Turn a thrown `Response` into a `NextResponse`, rebuilt from a known shape.
 *
 * The wrapper used to re-emit the thrown body verbatim. That was safe — every
 * `throw new Response` in this module builds its body from a string literal,
 * so nothing of the caller's could reach it. CodeQL flagged it as stack-trace
 * exposure regardless, because it cannot see that, and it has a point about
 * the pattern rather than the instance: a future throw site that interpolated
 * an exception into that body would start leaking with no visible change at
 * the re-wrap.
 *
 * Reconstructing costs one parse and removes the question. Exported so the
 * property can be tested directly, which piping a body through could not be.
 */
export async function rewrapAuthResponse(err: Response): Promise<NextResponse> {
  const parsed = (await err.json().catch(() => null)) as { error?: unknown } | null;
  // A non-string `error`, or no JSON at all, becomes the generic message: the
  // only values allowed out are ones this module put in.
  const message = typeof parsed?.error === 'string' ? parsed.error : 'unauthorized';
  return NextResponse.json({ error: message }, { status: err.status });
}

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
      return { response: await rewrapAuthResponse(err) };
    }
    return {
      response: NextResponse.json(
        { error: 'internal error during auth' },
        { status: 500 },
      ),
    };
  }
}
