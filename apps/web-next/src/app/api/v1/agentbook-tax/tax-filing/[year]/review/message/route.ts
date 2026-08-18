/**
 * One conversational turn inside an in-progress tax filing review.
 *
 * Production mirror of the Express plugin route of the same path — the
 * agent brain's `ctx.answerTaxReview` reaches this endpoint on Vercel.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { reviewErrorResponse } from '@/lib/agentbook-tax-review/errors';
import { answerReviewMessage } from '@agentbook-tax/tax-review-agent';
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
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = String(body?.text ?? '');
    const result = await answerReviewMessage(tenantId, parseInt(year, 10), text, callGemini);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return reviewErrorResponse('agentbook-tax/tax-filing/:year/review/message', err);
  }
}
