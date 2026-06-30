/**
 * Monthly AI-CPA review cron. For every tenant whose cpaReviewFrequency is
 * 'monthly', runs the review and upserts this month's report. Auth: Vercel
 * cron header or ?secret=CRON_SECRET (same pattern as the billing crons).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { runReviewForTenant } from '@/lib/cpa-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(request: NextRequest): boolean {
  const cron = request.headers.get('x-vercel-cron');
  const secret = request.nextUrl.searchParams.get('secret');
  return cron === '1' || (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
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
