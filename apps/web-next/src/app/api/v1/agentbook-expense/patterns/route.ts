/**
 * Expense vendor → category patterns — list.
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
    const patterns = await db.abPattern.findMany({
      where: { tenantId },
      orderBy: { usageCount: 'desc' },
    });
    return NextResponse.json({ success: true, data: patterns });
  } catch (err) {
    console.error('[agentbook-expense/patterns GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
