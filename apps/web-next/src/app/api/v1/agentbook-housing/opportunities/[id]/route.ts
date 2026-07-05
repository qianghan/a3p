/**
 * A single housing listing — get / update / delete. Tenant-scoped +
 * student_success-gated. Status lifecycle: considering → applied → toured →
 * secured → passed.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_STATUS = ['considering', 'applied', 'toured', 'secured', 'passed'];

async function owned(tenantId: string, id: string) {
  return db.abStudentOpportunity.findFirst({ where: { id, tenantId, kind: 'housing' } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const item = await owned(guard.tenantId, id);
  if (!item) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: item });
}

interface PatchBody {
  status?: string;
  rentCents?: number | null;
  payload?: Record<string, unknown>;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const existing = await owned(guard.tenantId, id);
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const update: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ success: false, error: `status must be one of ${VALID_STATUS.join(', ')}` }, { status: 400 });
    }
    update.status = body.status;
  }
  if (body.rentCents !== undefined) {
    update.amountCents =
      body.rentCents === null ? null
        : (typeof body.rentCents === 'number' && Number.isFinite(body.rentCents) && body.rentCents >= 0
            ? Math.round(body.rentCents) : existing.amountCents);
  }
  if (body.payload !== undefined && body.payload && typeof body.payload === 'object') {
    update.payload = { ...(existing.payload as Record<string, unknown>), ...body.payload };
  }

  const item = await db.abStudentOpportunity.update({ where: { id }, data: update });
  return NextResponse.json({ success: true, data: item });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  const { id } = await params;
  const existing = await owned(guard.tenantId, id);
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  await db.abStudentOpportunity.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
