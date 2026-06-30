/** Revoke a CPA review link. */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;
    const existing = await db.abCpaReviewLink.findFirst({ where: { id, tenantId } });
    if (!existing) return NextResponse.json({ success: false, error: 'link not found' }, { status: 404 });
    const link = await db.abCpaReviewLink.update({ where: { id }, data: { status: 'revoked' } });
    return NextResponse.json({ success: true, data: link });
  } catch (err) {
    console.error('[agentbook-cpa/link DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
