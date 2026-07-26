/**
 * Rep-coach cron — weekly ("0 15 * * 1", Mondays 3pm UTC). Coaches every
 * active sales rep (one encouraging message + milestone detection) and queues
 * commission-raise / reward recommendations for admin approval, then sends
 * admins a program digest. Bearer-gated when CRON_SECRET is set.
 *
 * Reads/writes via Prisma directly (no self-fetch), matching proactive-alerts.
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runRepCoach } from '@/lib/billing/sales-rep-coach';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && !safeCompareBearer(authHeader, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runRepCoach();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[cron/rep-coach] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
