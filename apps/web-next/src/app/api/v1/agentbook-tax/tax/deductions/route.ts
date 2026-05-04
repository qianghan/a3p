/**
 * Tax deduction suggestions — list with summary stats.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const status = request.nextUrl.searchParams.get('status');

    const where: Record<string, unknown> = { tenantId };
    if (status) where.status = status;

    const deductions = await db.abDeductionSuggestion.findMany({
      where,
      orderBy: { estimatedSavingsCents: 'desc' },
    });

    const totalSavingsCents = deductions
      .filter((d) => d.status !== 'dismissed')
      .reduce((s, d) => s + d.estimatedSavingsCents, 0);

    return NextResponse.json({
      success: true,
      data: {
        deductions,
        summary: {
          total: deductions.length,
          suggested: deductions.filter((d) => d.status === 'suggested').length,
          applied: deductions.filter((d) => d.status === 'applied').length,
          dismissed: deductions.filter((d) => d.status === 'dismissed').length,
          totalEstimatedSavingsCents: totalSavingsCents,
        },
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/tax/deductions] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
