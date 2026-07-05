/**
 * Grounded job / co-op discovery. Builds search context from the student's
 * profile (jurisdiction, region, visa status) so results are localized and
 * work-authorization-aware. student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';
import { discoverJobs } from '@/lib/agentbook-career/discover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface DiscoverBody {
  query?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => ({}))) as DiscoverBody;
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: guard.tenantId } });
    const result = await discoverJobs(
      {
        jurisdiction: (cfg?.jurisdiction ?? 'us').toLowerCase(),
        region: cfg?.region ?? '',
        visaStatus: cfg?.visaStatus ?? null,
      },
      body.query?.trim() || undefined,
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-career/discover] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
