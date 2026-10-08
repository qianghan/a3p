/**
 * AR aging report — group outstanding invoices into 5 age buckets.
 * The computation lives in lib/agentbook-aging.ts (shared with /mobile/home).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeAgingReport } from '@/lib/agentbook-aging';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const data = await computeAgingReport(tenantId);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[agentbook-invoice/aging-report] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
