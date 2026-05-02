/**
 * Resolve the AgentBook tenant ID for an inbound request.
 *
 * Priority:
 *  1. `x-tenant-id` header
 *  2. `ab-tenant` cookie
 *  3. `naap_auth_token` cookie → validateSession → user.id
 *  4. 'default'
 *
 * Plugin Express backends rely on this header for tenant isolation. The
 * previous proxy at `[plugin]/[...path]/route.ts` performed the same
 * resolution; dedicated route handlers must repeat it.
 */

import 'server-only';
import type { NextRequest } from 'next/server';

export async function resolveAgentbookTenant(request: NextRequest): Promise<string> {
  const headerTenant = request.headers.get('x-tenant-id');
  if (headerTenant) return headerTenant;

  const cookieTenant = request.cookies.get('ab-tenant')?.value;
  if (cookieTenant) return cookieTenant;

  const authToken = request.cookies.get('naap_auth_token')?.value;
  if (authToken) {
    try {
      const { validateSession } = await import('@/lib/api/auth');
      const user = await validateSession(authToken);
      if (user?.id) return user.id;
    } catch {
      /* fall through to default */
    }
  }

  return 'default';
}
