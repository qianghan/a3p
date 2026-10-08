/**
 * Tax estimate — native Next.js route.
 *
 * The computation lives in lib/agentbook-tax-estimate.ts (computeTaxEstimate),
 * shared with GET /agentbook-core/mobile/home so both surfaces show the same
 * number. Read-only: the AbTaxEstimate / AbEvent writes from the legacy
 * handler are intentionally omitted here to keep the function bundle minimal.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeTaxEstimate } from '@/lib/agentbook-tax-estimate';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;

    const data = await computeTaxEstimate(tenantId, {
      startDate: params.get('startDate'),
      endDate: params.get('endDate'),
      basis: params.get('basis'),
      period: params.get('period'),
    });

    // The legacy plugin frontend reads top-level snake_case dollar fields
    // (data.total_estimated_tax etc.); the new dashboard reads the cents
    // values under `data`. Emit both shapes to keep both consumers happy.
    return NextResponse.json({
      success: true,
      data,
      total_estimated_tax: data.totalTaxCents / 100,
      income_tax: data.incomeTaxCents / 100,
      self_employment_tax: data.seTaxCents / 100,
      effective_rate: data.effectiveRate,
      total_revenue: data.grossRevenueCents / 100,
      total_expenses: data.expensesCents / 100,
      net_income: data.netIncomeCents / 100,
      combined_mode: data.combinedMode,
      w2_income: data.w2IncomeCents / 100,
      w2_withheld: data.w2WithheldCents / 100,
      amount_owed: data.amountOwedCents / 100,
      quarterly_payments: [],
    });
  } catch (err) {
    console.error('[agentbook-tax/tax/estimate] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
