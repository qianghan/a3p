/** Owner view of CPA document requests — list (GET) + fulfill (POST). */

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
    const status = request.nextUrl.searchParams.get('status'); // open | fulfilled | all
    const requests = await db.abDocumentRequest.findMany({
      where: { tenantId, ...(status && status !== 'all' ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ success: true, data: requests });
  } catch (err) {
    console.error('[agentbook-cpa/document-requests GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { id?: string; url?: string };
    if (!body.id || !body.url) {
      return NextResponse.json({ success: false, error: 'id and url are required' }, { status: 400 });
    }
    const reqRow = await db.abDocumentRequest.findFirst({ where: { id: body.id, tenantId } });
    if (!reqRow) return NextResponse.json({ success: false, error: 'request not found' }, { status: 404 });
    const updated = await db.abDocumentRequest.update({
      where: { id: reqRow.id },
      data: { status: 'fulfilled', fulfilledUrl: body.url, fulfilledAt: new Date() },
    });
    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-cpa/document-requests POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
