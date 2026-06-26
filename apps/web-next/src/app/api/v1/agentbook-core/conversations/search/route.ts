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

    const { searchParams } = request.nextUrl;
    const q = searchParams.get('q')?.trim() ?? '';
    const channel = searchParams.get('channel') ?? '';
    const cursor = searchParams.get('cursor') ?? '';
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

    const where = {
      tenantId,
      ...(channel ? { channel } : {}),
      ...(q ? {
        OR: [
          { question: { contains: q, mode: 'insensitive' as const } },
          { answer:    { contains: q, mode: 'insensitive' as const } },
        ],
      } : {}),
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    };

    const countWhere = {
      tenantId,
      ...(channel ? { channel } : {}),
      ...(q ? {
        OR: [
          { question: { contains: q, mode: 'insensitive' as const } },
          { answer:    { contains: q, mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    const [items, total] = await Promise.all([
      db.abConversation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      db.abConversation.count({ where: countWhere }),
    ]);

    const nextCursor = items.length === limit
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return NextResponse.json({ success: true, data: { items, nextCursor, total } });
  } catch (err) {
    console.error('[conversations/search] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
