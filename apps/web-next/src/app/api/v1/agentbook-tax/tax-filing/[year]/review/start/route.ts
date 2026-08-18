/**
 * Start (or restart) the conversational review of a tax filing.
 *
 * Production mirror of the Express plugin route of the same path.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { startReview } from '@agentbook-tax/tax-review-agent';
import { callGemini } from '@/lib/agentbook-tax-review/gemini';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { year } = await params;
    const result = await startReview(tenantId, parseInt(year, 10), callGemini);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-filing/:year/review/start] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
