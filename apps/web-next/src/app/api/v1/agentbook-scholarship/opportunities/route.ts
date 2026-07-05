/**
 * Scholarship opportunities — list (GET) + create (POST).
 * Backed by the shared AbStudentOpportunity model (kind='scholarship').
 * Gated by the student_success add-on.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireScholarshipAccess } from '@/lib/agentbook-scholarship/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KIND = 'scholarship';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
  if ('response' in guard) return guard.response;
  try {
    const items = await db.abStudentOpportunity.findMany({
      where: { tenantId: guard.tenantId, kind: KIND },
      orderBy: [{ status: 'asc' }, { deadline: 'asc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error('[agentbook-scholarship/opportunities GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateBody {
  title?: string;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  deadline?: string | null; // ISO date
  amountText?: string | null; // free-text; stored in payload, not parsed to cents
  eligibilitySummary?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
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
        status: 'shortlisted', // saving one = the student has chosen to track it
        sourceUrl: body.sourceUrl?.trim() || null,
        sourceLabel: body.sourceLabel?.trim() || null,
        deadline,
        payload: {
          amountText: body.amountText?.trim() || null,
          eligibilitySummary: body.eligibilitySummary?.trim() || null,
        },
      },
    });
    return NextResponse.json({ success: true, data: item }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-scholarship/opportunities POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
