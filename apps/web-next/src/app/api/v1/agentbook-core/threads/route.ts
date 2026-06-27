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

    const channel = request.nextUrl.searchParams.get('channel') ?? undefined;
    const status  = request.nextUrl.searchParams.get('status')  ?? undefined;

    const threads = await db.abConvThread.findMany({
      where: {
        tenantId,
        ...(channel ? { channel } : {}),
        ...(status  ? { status  } : {}),
      },
      orderBy: { lastActiveAt: 'desc' },
      take: 50,
    });

    const data = threads.map((t) => {
      const turns = (t.turns as Array<{ role: string; text: string; at: string }>) ?? [];
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
      return {
        id: t.id,
        channel: t.channel,
        chatId: t.chatId,
        status: t.status,
        lastActiveAt: t.lastActiveAt,
        summary: t.summary,
        lastTurn,
      };
    });

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[threads] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
