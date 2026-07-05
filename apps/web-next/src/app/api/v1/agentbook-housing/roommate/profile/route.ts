/**
 * Roommate profile — the student's own opt-in matching profile.
 *   GET    → the caller's profile, or { data: null } if they've never opted in
 *   PUT    → create/update; activating (active=true) REQUIRES explicit consent
 *   DELETE → withdraw entirely (removes from every match pool immediately)
 *
 * Privacy: stores no contact info and no precise address by design — see the
 * AbRoommateProfile model comment. student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const profile = await db.abRoommateProfile.findUnique({ where: { tenantId: guard.tenantId } });
    return NextResponse.json({ success: true, data: profile });
  } catch (err) {
    console.error('[roommate/profile GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface PutBody {
  active?: boolean;
  consent?: boolean; // must be true to activate
  displayHandle?: string;
  jurisdiction?: string;
  area?: string;
  budgetMinCents?: number | null;
  budgetMaxCents?: number | null;
  moveInMonth?: string | null;
  lifestyle?: unknown;
  bio?: string | null;
}

function cleanCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 40)
    .slice(0, 12);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => ({}))) as PutBody;
    const active = body.active === true;

    // Opting in / staying discoverable requires explicit consent every time.
    if (active && body.consent !== true) {
      return NextResponse.json(
        { success: false, error: 'Consent is required to make your roommate profile discoverable.' },
        { status: 400 },
      );
    }

    const handle = (body.displayHandle ?? '').trim();
    const area = (body.area ?? '').trim();
    const jurisdiction = (body.jurisdiction ?? '').trim().toLowerCase();
    if (active) {
      if (!handle) return NextResponse.json({ success: false, error: 'A display handle is required.' }, { status: 400 });
      if (!area) return NextResponse.json({ success: false, error: 'An area is required.' }, { status: 400 });
      if (jurisdiction !== 'us' && jurisdiction !== 'ca') {
        return NextResponse.json({ success: false, error: 'Jurisdiction must be "us" or "ca".' }, { status: 400 });
      }
    }

    const data = {
      active,
      displayHandle: handle || 'Student',
      jurisdiction: jurisdiction === 'ca' ? 'ca' : 'us',
      area,
      budgetMinCents: cleanCents(body.budgetMinCents),
      budgetMaxCents: cleanCents(body.budgetMaxCents),
      moveInMonth: (body.moveInMonth ?? '').trim() || null,
      lifestyle: cleanTags(body.lifestyle),
      bio: (body.bio ?? '').trim().slice(0, 500) || null,
      consentAt: active ? new Date() : null,
    };

    const profile = await db.abRoommateProfile.upsert({
      where: { tenantId: guard.tenantId },
      create: { tenantId: guard.tenantId, ...data },
      update: data,
    });
    return NextResponse.json({ success: true, data: profile });
  } catch (err) {
    console.error('[roommate/profile PUT] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    await db.abRoommateProfile.deleteMany({ where: { tenantId: guard.tenantId } });
    return NextResponse.json({ success: true, data: { deleted: true } });
  } catch (err) {
    console.error('[roommate/profile DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
