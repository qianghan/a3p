/**
 * Tax slips library — list slips for a tax year.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { listSlips } from '@agentbook-tax/tax-slips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const taxYear = parseInt(request.nextUrl.searchParams.get('taxYear') || '2025', 10);
    const result = await listSlips(tenantId, taxYear);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-slips] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
