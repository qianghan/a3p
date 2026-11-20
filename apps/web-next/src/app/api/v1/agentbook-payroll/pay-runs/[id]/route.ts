/** Pay run detail with stubs (GET); delete a DRAFT run (DELETE, PR 4c). */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';

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
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

/** Only drafts can be deleted — processed/paid runs are ledger snapshots. */
export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const run = await db.abPayRun.findFirst({ where: { id, tenantId } });
    if (!run) return NextResponse.json({ success: false, error: 'pay run not found' }, { status: 404 });
    if (run.status !== 'draft') return NextResponse.json({ success: false, error: 'only draft pay runs can be deleted' }, { status: 409 });
    await db.$transaction(async (tx) => {
      await tx.abPayStub.deleteMany({ where: { payRunId: id, tenantId } });
      await tx.abPayRun.deleteMany({ where: { id, tenantId, status: 'draft' } });
    });
    return NextResponse.json({ success: true, data: { id, deleted: true } });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs/:id DELETE] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
