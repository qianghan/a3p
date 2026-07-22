/**
 * POST /api/v1/agentbook-expense/bank/basiq/consent-url
 *
 * Builds the URL for Basiq's *hosted* Consent UI. Unlike Plaid Link, Basiq
 * has no client-embeddable widget and no app-initiated "create connection"
 * call for this flow — the browser is redirected straight to
 * `consent.basiq.io`, where Basiq's own page collects the institution +
 * credentials and creates the connection/job internally. Basiq then
 * redirects the browser back to this plugin's `callback/route.ts` with the
 * resulting `jobId` (and `state`) as query params — see that route and
 * `status/route.ts` for the rest of the flow.
 *
 * Lazily creates the tenant's Basiq user (`basiqUserId`) on first use.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { createBasiqUser, getBasiqClientToken, sanitizeBasiqError } from '@/lib/agentbook-basiq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    let basiqUserId = config?.basiqUserId;
    if (!basiqUserId) {
      const user = await db.user.findUnique({ where: { id: tenantId } });
      const created = await createBasiqUser(tenantId, user?.email ?? `${tenantId}@agentbook.local`);
      basiqUserId = created.basiqUserId;
      await db.abTenantConfig.upsert({
        where: { userId: tenantId },
        create: { userId: tenantId, basiqUserId },
        update: { basiqUserId },
      });
    }

    const clientToken = await getBasiqClientToken(basiqUserId);

    // `state` carries the tenant id through Basiq's redirect round-trip so
    // the callback route has it even if a browser drops cookies across the
    // third-party navigation (not currently relied on by callback/route.ts,
    // which only forwards `jobId`, but kept for forward-compatibility and
    // as a CSRF-style correlation value).
    const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
    const redirectUrl = `${appOrigin}/api/v1/agentbook-expense/bank/basiq/callback`;
    const consentUrl =
      `https://consent.basiq.io/home?token=${encodeURIComponent(clientToken)}` +
      `&redirectUrl=${encodeURIComponent(redirectUrl)}` +
      `&state=${encodeURIComponent(tenantId)}`;

    return NextResponse.json({ success: true, data: { consentUrl } });
  } catch (err) {
    console.error('[basiq/consent-url POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
