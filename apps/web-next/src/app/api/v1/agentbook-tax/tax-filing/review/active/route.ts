/**
 * Is there an in-progress tax filing review for this tenant?
 *
 * Production mirror of the Express plugin route of the same path — the
 * agent brain's `ctx.checkActiveTaxReview` reaches this endpoint on
 * Vercel, where the tax plugin is served by these Next handlers rather
 * than the standalone Express server.
 *
 * Note: `review` is a static sibling of the `[year]` dynamic segment;
 * Next.js resolves the static segment first, so this never shadows
 * `/tax-filing/2025/...`.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getActiveReviewForTenant } from '@agentbook-tax/tax-review-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const active = await getActiveReviewForTenant(tenantId);
    return NextResponse.json({
      success: true,
      data: active ? { active: true, taxYear: active.taxYear } : { active: false },
    });
  } catch (err) {
    console.error('[agentbook-tax/tax-filing/review/active] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
