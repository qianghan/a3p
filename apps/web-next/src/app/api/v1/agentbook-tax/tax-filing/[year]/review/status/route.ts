/**
 * Has this filing been reviewed AND confirmed against its current numbers?
 *
 * Production mirror of the Express plugin route of the same path — this is
 * the endpoint `handleTaxFilingSubmit`'s submit gate checks before it will
 * call the real submit endpoint.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getReviewState } from '@agentbook-tax/tax-review-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { year } = await params;
    // Read-only. `confirmedAndFresh` is what the submit gate reads; the rest
    // is additive, and lets the web review tab render an existing review
    // without POSTing review/start (which burns an LLM call and un-confirms
    // the row).
    // `state` already carries confirmedAndFresh — the field the submit gate
    // reads — alongside the additive rendering fields.
    const state = await getReviewState(tenantId, parseInt(year, 10));
    return NextResponse.json({ success: true, data: state });
  } catch (err) {
    console.error('[agentbook-tax/tax-filing/:year/review/status] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
