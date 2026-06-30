/** The named CPA requests a document (token-gated via the invite). */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveActiveInvite } from '@/lib/cpa-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const { token } = await ctx.params;
    const invite = await resolveActiveInvite(token);
    if (!invite) return NextResponse.json({ success: false, error: 'this invite is no longer active' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { description?: string; expenseId?: string };
    if (!body.description || !body.description.trim()) {
      return NextResponse.json({ success: false, error: 'description is required' }, { status: 400 });
    }
    const req = await db.abDocumentRequest.create({
      data: {
        tenantId: invite.tenantId,
        requestedByEmail: invite.cpaEmail,
        expenseId: body.expenseId || null,
        description: body.description.trim().slice(0, 500),
        status: 'open',
      },
    });
    return NextResponse.json({ success: true, data: req }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-cpa/portal/document-request POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
