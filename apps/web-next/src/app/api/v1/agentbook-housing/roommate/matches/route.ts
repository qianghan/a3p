/**
 * Roommate matches — ranked, opted-in profiles compatible with the caller's.
 *
 * Consulting-only: returns compatibility scores + human reasons + the other
 * student's self-chosen display handle, area, budget, move-in, and lifestyle
 * tags. It returns NO contact information (none is stored), and it never
 * contacts anyone — the student decides who to reach out to, through their own
 * school/housing channels.
 *
 * The pool is only ACTIVE profiles (opted in), excluding the caller. Requires
 * the caller to have an active profile themselves — you must be discoverable
 * to browse the pool (reciprocity), which also stops passive scraping.
 * student_success-gated.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireStudentAddon } from '@/lib/agentbook-student/guard';
import { scoreMatch, type RoommateProfileLike } from '@/lib/agentbook-housing/roommate-match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function toLike(p: {
  tenantId: string;
  jurisdiction: string;
  area: string;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  moveInMonth: string | null;
  lifestyle: unknown;
}): RoommateProfileLike {
  return {
    tenantId: p.tenantId,
    jurisdiction: p.jurisdiction,
    area: p.area,
    budgetMinCents: p.budgetMinCents,
    budgetMaxCents: p.budgetMaxCents,
    moveInMonth: p.moveInMonth,
    lifestyle: Array.isArray(p.lifestyle) ? (p.lifestyle as string[]) : [],
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireStudentAddon(request);
  if ('response' in guard) return guard.response;
  try {
    const mine = await db.abRoommateProfile.findUnique({ where: { tenantId: guard.tenantId } });
    if (!mine || !mine.active) {
      return NextResponse.json(
        { success: true, data: { matches: [], note: 'Turn on your roommate profile to see compatible students.' } },
      );
    }

    // Only opted-in profiles, same jurisdiction, excluding myself.
    const pool = await db.abRoommateProfile.findMany({
      where: { active: true, jurisdiction: mine.jurisdiction, NOT: { tenantId: guard.tenantId } },
      take: 200,
    });

    const meLike = toLike(mine);
    const matches = pool
      .map((p) => {
        const scored = scoreMatch(meLike, toLike(p));
        if (!scored) return null;
        // Deliberately NO tenantId / contact info in the response.
        return {
          displayHandle: p.displayHandle,
          area: p.area,
          budgetMinCents: p.budgetMinCents,
          budgetMaxCents: p.budgetMaxCents,
          moveInMonth: p.moveInMonth,
          lifestyle: Array.isArray(p.lifestyle) ? (p.lifestyle as string[]) : [],
          bio: p.bio,
          score: scored.score,
          reasons: scored.reasons,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    const note = matches.length === 0
      ? 'No compatible students yet. As more students opt in for your area, matches will appear here.'
      : 'Compatibility only — AgentBook never messages anyone for you. Reach out through your school or housing group.';
    return NextResponse.json({ success: true, data: { matches, note } });
  } catch (err) {
    console.error('[roommate/matches GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
