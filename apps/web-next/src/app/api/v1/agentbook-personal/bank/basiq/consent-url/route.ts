import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { createBasiqUser, getBasiqClientToken, sanitizeBasiqError } from '@/lib/agentbook-basiq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Builds the hosted Consent UI redirect URL for a personal-finance (AU)
 * tenant. Mirrors the business-side `agentbook-expense/bank/basiq/consent-url`
 * route (AU-1 Task 2) with one gating difference: this route — like the rest
 * of personal-finance bank sync — sits behind the paid Personal Insights
 * add-on (`requirePersonalInsightsAddon`), matching Plaid's exact precedent
 * for personal-finance (`agentbook-personal/plaid/link-token`).
 *
 * Does NOT call any "create connection" endpoint — there is none. Basiq's
 * hosted Consent UI collects the institution + credentials itself and
 * redirects the browser back to `callback/route.ts` with a `jobId` once the
 * user completes consent. See `agentbook-basiq.ts`'s file header for the
 * full corrected flow description.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    let config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    let basiqUserId = config?.basiqUserId ?? undefined;

    if (!basiqUserId) {
      const user = await db.user.findUnique({ where: { id: tenantId } });
      const { basiqUserId: newId } = await createBasiqUser(
        tenantId,
        user?.email ?? `${tenantId}@agentbook.local`,
      );
      basiqUserId = newId;
      await db.abTenantConfig.upsert({
        where: { userId: tenantId },
        create: { userId: tenantId, basiqUserId },
        update: { basiqUserId },
      });
    }

    const clientToken = await getBasiqClientToken(basiqUserId);
    // `state` carries the tenant id through Basiq's redirect round-trip so
    // the callback route could resolve the tenant without relying solely on
    // a cookie surviving the third-party navigation (the callback route
    // itself does not currently need it — see that route's comment — but it
    // is threaded through for forward-compatibility and parity with the
    // business-side route).
    const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
    const redirectUrl = `${appOrigin}/api/v1/agentbook-personal/bank/basiq/callback`;
    const consentUrl =
      `https://consent.basiq.io/home?token=${encodeURIComponent(clientToken)}` +
      `&redirectUrl=${encodeURIComponent(redirectUrl)}` +
      `&state=${encodeURIComponent(tenantId)}`;

    return NextResponse.json({ success: true, data: { consentUrl } });
  } catch (err) {
    console.error('[agentbook-personal/bank/basiq/consent-url POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
