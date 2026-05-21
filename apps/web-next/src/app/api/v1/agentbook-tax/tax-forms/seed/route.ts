/**
 * Tax forms seed — populate AbTaxForm with Canadian T1 / T2125 / GST.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { seedCanadianForms } from '@agentbook-tax/tax-forms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const result = await seedCanadianForms();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-forms/seed] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
