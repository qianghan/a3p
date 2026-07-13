/**
 * Grounded scholarship discovery. Builds the search context from the
 * student's own profile (jurisdiction, region, visa status, home country)
 * so results are localized and eligibility-aware, then returns source-cited
 * candidates. student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireScholarshipAccess } from '@/lib/agentbook-scholarship/guard';
import { discoverScholarships } from '@/lib/agentbook-scholarship/discover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface DiscoverBody {
  query?: string; // optional free-text focus, e.g. "for computer science" / "need-based"
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireScholarshipAccess(request);
  if ('response' in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => ({}))) as DiscoverBody;
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: guard.tenantId } });
    const result = await discoverScholarships(
      {
        jurisdiction: (cfg?.jurisdiction ?? 'us').toLowerCase(),
        region: cfg?.region ?? '',
        school: cfg?.university ?? null,
        program: cfg?.major ?? null,
        level: cfg?.degree ?? null,
        visaStatus: cfg?.visaStatus ?? null,
        homeCountry: cfg?.homeCountry ?? null,
      },
      body.query?.trim() || undefined,
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-scholarship/discover] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
