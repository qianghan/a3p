/**
 * Public: an accountant approves ("signs off") the books for a period via a
 * token-gated review link. One sign-off per tenant+period (upsert).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveActiveLink } from '@/lib/cpa-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ token: string }> }

function currentMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const { token } = await ctx.params;
    const link = await resolveActiveLink(token);
    if (!link) return NextResponse.json({ success: false, error: 'this link is no longer active' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { period?: string; cpaName?: string; cpaEmail?: string };
    const period = body.period || currentMonthKey();

    const signoff = await db.abBookSignoff.upsert({
      where: { tenantId_period: { tenantId: link.tenantId, period } },
      update: { cpaName: body.cpaName?.slice(0, 120) || null, cpaEmail: body.cpaEmail?.slice(0, 200) || null, viaToken: token, signedAt: new Date() },
      create: { tenantId: link.tenantId, period, cpaName: body.cpaName?.slice(0, 120) || null, cpaEmail: body.cpaEmail?.slice(0, 200) || null, viaToken: token },
    });

    return NextResponse.json({ success: true, data: signoff }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-cpa/public/signoff POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
