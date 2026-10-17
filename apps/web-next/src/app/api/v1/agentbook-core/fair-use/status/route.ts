/**
 * Fair-use status — the caller's own monthly AI-message budget usage.
 * P0-6: gives users (and the Settings UI) visibility into where they stand
 * against the fair-use ceiling. No admin auth needed: tenants only ever see
 * their own numbers.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { fairUseStatus } from '@/lib/agentbook-fair-use';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const { getCurrentPlan } = await import('@naap/billing');
    const planCode = (await getCurrentPlan(tenantId).catch(() => null))?.plan.code ?? 'free';
    const status = await fairUseStatus(tenantId, planCode);

    return NextResponse.json({ success: true, data: status });
  } catch (err) {
    console.error('[agentbook-core/fair-use/status] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
