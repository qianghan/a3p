/** Public: an accountant leaves a comment on a token-gated review link. */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveActiveLink } from '@/lib/cpa-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const { token } = await ctx.params;
    const link = await resolveActiveLink(token);
    if (!link) return NextResponse.json({ success: false, error: 'this link is no longer active' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { body?: string; authorName?: string; authorEmail?: string };
    if (!body.body || !body.body.trim()) {
      return NextResponse.json({ success: false, error: 'comment body is required' }, { status: 400 });
    }
    const comment = await db.abCpaComment.create({
      data: {
        linkId: link.id,
        body: body.body.trim().slice(0, 2000),
        authorName: body.authorName?.slice(0, 120) || null,
        authorEmail: body.authorEmail?.slice(0, 200) || null,
      },
    });
    return NextResponse.json({ success: true, data: comment }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-cpa/public/comment POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
