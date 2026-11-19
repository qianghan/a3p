/**
 * Who is acting, for routes that must distinguish the tenant OWNER from a
 * service caller (PR 4b — employee PII reveal).
 *
 * safeResolveAgentbookTenant accepts two kinds of caller: a user session
 * (tenantId === user.id — the tenant model is single-user, so that user IS
 * the owner/admin of the books) and a CRON_SECRET service call that names any
 * tenant in x-tenant-id. A service call must never reveal an employee's PII,
 * so the owner check re-reads the session cookie and requires
 * session user id === tenantId.
 */

import 'server-only';
import type { NextRequest } from 'next/server';

/** The session user id, or null when the request carries no valid user session. */
export async function resolveSessionUserId(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get('naap_auth_token')?.value;
  if (!token) return null;
  try {
    const { validateSession } = await import('@/lib/api/auth');
    const user = await validateSession(token);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

export async function isTenantOwner(request: NextRequest, tenantId: string): Promise<boolean> {
  return (await resolveSessionUserId(request)) === tenantId;
}
