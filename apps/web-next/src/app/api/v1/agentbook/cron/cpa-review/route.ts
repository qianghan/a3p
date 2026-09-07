/**
 * Monthly AI-CPA review cron. For every tenant whose cpaReviewFrequency is
 * 'monthly', runs the review and upserts this month's report. Auth: Vercel
 * cron header or ?secret=CRON_SECRET (same pattern as the billing crons).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { runReviewForTenant } from '@/lib/cpa-run';
import { requireCronSecret } from '@/lib/cron-auth';

// Auth: the shared fail-closed helper. This route used to authorise on
// `x-vercel-cron: 1` ALONE — an ordinary inbound header any caller can send —
// with the secret as a mere alternative. Since vercel.json's cron config
// carries no `?secret=`, that header was the only live auth path. The helper
// accepts the `Authorization: Bearer` Vercel attaches to a cron invocation.


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;


async function handle(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;
  const tenants = await db.abTenantConfig.findMany({
    where: { cpaReviewFrequency: 'monthly' },
    select: { userId: true },
  });

  let reviewed = 0;
  for (const t of tenants) {
    try {
      await runReviewForTenant(t.userId);
      reviewed++;
    } catch (err) {
      console.error('[cron/cpa-review] tenant failed:', t.userId, err);
    }
  }
  return NextResponse.json({ success: true, data: { tenants: tenants.length, reviewed } });
}

export async function GET(request: NextRequest): Promise<NextResponse> { return handle(request); }
export async function POST(request: NextRequest): Promise<NextResponse> { return handle(request); }
