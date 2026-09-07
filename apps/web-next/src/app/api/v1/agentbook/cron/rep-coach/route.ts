/**
 * Rep-coach cron — weekly ("0 15 * * 1", Mondays 3pm UTC). Coaches every
 * active sales rep (one encouraging message + milestone detection) and queues
 * commission-raise / reward recommendations for admin approval, then sends
 * admins a program digest. Bearer-gated when CRON_SECRET is set.
 *
 * Reads/writes via Prisma directly (no self-fetch), matching proactive-alerts.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { runRepCoach } from '@/lib/billing/sales-rep-coach';
import { requireCronSecret } from '@/lib/cron-auth';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;


export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;
  try {
    const result = await runRepCoach();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[cron/rep-coach] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
