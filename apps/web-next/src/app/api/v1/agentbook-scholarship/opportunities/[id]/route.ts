/**
 * A single scholarship opportunity — get (GET), update status/fields (PATCH),
 * delete (DELETE). Tenant-scoped + student_success-gated. PATCH is how the
 * student moves an item through the lifecycle (shortlisted → preparing →
 * ready → submitted → closed) — the app never auto-submits.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireScholarshipAccess } from '@/lib/agentbook-scholarship/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_STATUS = ['discovered', 'shortlisted', 'preparing', 'ready', 'submitted', 'closed'];

async function ownedOpportunity(tenantId: string, id: string) {
  const item = await db.abStudentOpportunity.findFirst({ where: { id, tenantId, kind: 'scholarship' } });
  return item;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const item = await ownedOpportunity(guard.tenantId, id);
  if (!item) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: item });
}

interface PatchBody {
  status?: string;
  deadline?: string | null;
  payload?: Record<string, unknown>;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const existing = await ownedOpportunity(guard.tenantId, id);
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const update: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ success: false, error: `status must be one of ${VALID_STATUS.join(', ')}` }, { status: 400 });
    }
    update.status = body.status;
  }
  if (body.deadline !== undefined) {
    if (body.deadline === null) update.deadline = null;
    else {
      const d = new Date(body.deadline);
      update.deadline = Number.isNaN(d.getTime()) ? existing.deadline : d;
    }
  }
  if (body.payload !== undefined && body.payload && typeof body.payload === 'object') {
    // Merge, don't clobber, the kind-specific payload.
    update.payload = { ...(existing.payload as Record<string, unknown>), ...body.payload };
  }

  const item = await db.abStudentOpportunity.update({ where: { id }, data: update });
  return NextResponse.json({ success: true, data: item });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const existing = await ownedOpportunity(guard.tenantId, id);
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  await db.abStudentOpportunity.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
