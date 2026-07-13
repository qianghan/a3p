/**
 * Career opportunities — list (GET) + create (POST). Shared
 * AbStudentOpportunity model (kind='job'). student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KIND = 'job';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const items = await db.abStudentOpportunity.findMany({
      where: { tenantId: guard.tenantId, kind: KIND },
      orderBy: [{ status: 'asc' }, { deadline: 'asc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[agentbook-career/opportunities GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateBody {
  title?: string;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  deadline?: string | null;
  employer?: string | null;
  location?: string | null;
  compText?: string | null;
  summary?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    if (!body.title || !body.title.trim()) {
      return NextResponse.json({ success: false, error: 'title is required' }, { status: 400 });
    }
    let deadline: Date | null = null;
    if (body.deadline) {
      const d = new Date(body.deadline);
      if (!Number.isNaN(d.getTime())) deadline = d;
    }
    const item = await db.abStudentOpportunity.create({
      data: {
        tenantId: guard.tenantId,
        kind: KIND,
        title: body.title.trim(),
        status: 'shortlisted',
        sourceUrl: body.sourceUrl?.trim() || null,
        sourceLabel: body.sourceLabel?.trim() || null,
        deadline,
        payload: {
          employer: body.employer?.trim() || null,
          location: body.location?.trim() || null,
          compText: body.compText?.trim() || null,
          summary: body.summary?.trim() || null,
        },
      },
    });
    return NextResponse.json({ success: true, data: item }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-career/opportunities POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
