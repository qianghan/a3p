/**
 * Confirm a reviewed filing and submit it, in one turn.
 *
 * Production mirror of the Express plugin route of the same path.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { confirmAndSubmit } from '@agentbook-tax/tax-review-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { year } = await params;
    const result = await confirmAndSubmit(tenantId, parseInt(year, 10));
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-filing/:year/review/confirm] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
