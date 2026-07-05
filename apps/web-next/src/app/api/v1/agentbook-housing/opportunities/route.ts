/**
 * Housing listings — list (GET) + create (POST). Shared AbStudentOpportunity
 * model (kind='housing'); monthly rent stored in amountCents, other details
 * in payload. Listings are user-saved (paste what you're already looking at)
 * — no scraping / live feeds, by design. student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KIND = 'housing';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const items = await db.abStudentOpportunity.findMany({
      where: { tenantId: guard.tenantId, kind: KIND },
      orderBy: [{ status: 'asc' }, { amountCents: 'asc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[agentbook-housing/opportunities GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateBody {
  title?: string;
  rentCents?: number | null;
  currency?: string | null;
  sourceUrl?: string | null;
  area?: string | null;
  commute?: string | null;
  leaseTerm?: string | null;
  notes?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    if (!body.title || !body.title.trim()) {
      return NextResponse.json({ success: false, error: 'title is required' }, { status: 400 });
    }
    const rentCents =
      typeof body.rentCents === 'number' && Number.isFinite(body.rentCents) && body.rentCents >= 0
        ? Math.round(body.rentCents)
        : null;
    const item = await db.abStudentOpportunity.create({
      data: {
        tenantId: guard.tenantId,
        kind: KIND,
        title: body.title.trim(),
        status: 'considering',
        sourceUrl: body.sourceUrl?.trim() || null,
        amountCents: rentCents,
        currency: body.currency?.trim() || null,
        payload: {
          area: body.area?.trim() || null,
          commute: body.commute?.trim() || null,
          leaseTerm: body.leaseTerm?.trim() || null,
          notes: body.notes?.trim() || null,
        },
      },
    });
    return NextResponse.json({ success: true, data: item }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-housing/opportunities POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
