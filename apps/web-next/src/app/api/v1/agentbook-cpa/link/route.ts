/**
 * CPA review links — list (GET) + create (POST). A link is a token that lets
 * an accountant view read-only books and leave a comment / sign off, without
 * an AgentBook account. Default validity 90 days.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const links = await db.abCpaReviewLink.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { comments: true } } },
    });
    return NextResponse.json({ success: true, data: links });
  } catch (err) {
    console.error('[agentbook-cpa/link GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { label?: string; validityDays?: number };

    const days = typeof body.validityDays === 'number' && body.validityDays > 0 && body.validityDays <= 365
      ? Math.floor(body.validityDays) : 90;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const link = await db.abCpaReviewLink.create({
      data: { tenantId, label: body.label || null, expiresAt },
    });

    return NextResponse.json({
      success: true,
      data: { ...link, url: `/review/${link.token}` },
    }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-cpa/link POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
