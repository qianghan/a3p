/**
 * Daily account hard-delete cron (Launch-gap PR-9).
 *
 * Runs hardDeleteScheduledAccounts() for tenants whose 30-day
 * account-deletion grace period (started by DELETE /api/v1/agentbook/me)
 * has elapsed. Bearer-gated when CRON_SECRET is set, matching every other
 * cron route in this codebase.
 *
 * NOT registered in vercel.json's crons array yet — see the PR that
 * introduced this file for the explicit production-enablement checkpoint.
 */

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { hardDeleteScheduledAccounts } from '@/lib/agentbook-account-hard-delete';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function safeCompareBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    !safeCompareBearer(authHeader, process.env.CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await hardDeleteScheduledAccounts();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    void reportError('cron/account-hard-delete failed', err, { source: 'cron/account-hard-delete' });
    return NextResponse.json(
      { success: false, error: 'account hard-delete failed' },
      { status: 500 },
    );
  }
}
