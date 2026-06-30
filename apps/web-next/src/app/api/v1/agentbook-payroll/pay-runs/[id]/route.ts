/** Pay run detail with stubs. */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const run = await db.abPayRun.findFirst({ where: { id, tenantId }, include: { stubs: true } });
    if (!run) return NextResponse.json({ success: false, error: 'pay run not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: run });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs/:id GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
