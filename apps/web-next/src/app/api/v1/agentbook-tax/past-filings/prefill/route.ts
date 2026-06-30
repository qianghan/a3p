import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getPrefillSuggestions } from '@agentbook-tax/tax-past-filings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const searchParams = request.nextUrl.searchParams;
    const year = parseInt(searchParams.get('year') || '', 10) || new Date().getFullYear();
    const data = await getPrefillSuggestions(tenantId, year);
    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}
