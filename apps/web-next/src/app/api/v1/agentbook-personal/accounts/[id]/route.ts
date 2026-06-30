/** Personal account — update balance/name (PUT) and archive (DELETE). */

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
    const body = (await request.json().catch(() => ({}))) as { name?: string; balanceCents?: number };

    const existing = await db.abPersonalAccount.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'account not found' }, { status: 404 });

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.balanceCents !== undefined) update.balanceCents = body.balanceCents;

    const account = await db.abPersonalAccount.update({ where: { id }, data: update });
    return NextResponse.json({ success: true, data: account });
  } catch (err) {
    console.error('[agentbook-personal/accounts PUT] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const existing = await db.abPersonalAccount.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'account not found' }, { status: 404 });
    const account = await db.abPersonalAccount.update({ where: { id }, data: { archived: true } });
    return NextResponse.json({ success: true, data: account });
  } catch (err) {
    console.error('[agentbook-personal/accounts DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
