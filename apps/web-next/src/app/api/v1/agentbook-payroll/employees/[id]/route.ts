/** Payroll employee — update (PUT) and deactivate (DELETE). */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const existing = await db.abEmployee.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'employee not found' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const allowed = ['name', 'email', 'type', 'payType', 'payRateCents', 'payFrequency', 'jurisdiction', 'region', 'filingStatus'];
    const update: Record<string, unknown> = {};
    for (const k of allowed) if (body[k] !== undefined) update[k] = body[k];

    const employee = await db.abEmployee.update({ where: { id }, data: update });
    return NextResponse.json({ success: true, data: employee });
  } catch (err) {
    console.error('[agentbook-payroll/employees PUT] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const existing = await db.abEmployee.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'employee not found' }, { status: 404 });
    const employee = await db.abEmployee.update({ where: { id }, data: { isActive: false } });
    return NextResponse.json({ success: true, data: employee });
  } catch (err) {
    console.error('[agentbook-payroll/employees DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
